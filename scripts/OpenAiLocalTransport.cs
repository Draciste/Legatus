using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

public static class OpenAiLocalTransportV6
{
    private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

    private sealed class OpenAiLocalOutputLimitException : IOException
    {
        public OpenAiLocalOutputLimitException() : base("The response exceeded the output limit.") {}
    }

    public sealed class NativeCapture
    {
        private readonly MemoryStream stdout = new MemoryStream();
        private readonly MemoryStream stderr = new MemoryStream();
        private bool outputTruncated;
        private bool diagnosticTruncated;
        public Task IoCompletion { get; internal set; }

        internal void Append(bool diagnostic, byte[] buffer, int count)
        {
            var target = diagnostic ? stderr : stdout;
            lock (target)
            {
                int remaining = 256 * 1024 - (int)target.Length;
                target.Write(buffer, 0, Math.Min(count, remaining));
                if (count > remaining)
                {
                    if (diagnostic) diagnosticTruncated = true;
                    else outputTruncated = true;
                }
            }
        }

        public (string Text, bool Truncated) Snapshot(bool diagnostic)
        {
            var target = diagnostic ? stderr : stdout;
            lock (target)
            {
                bool truncated = diagnostic ? diagnosticTruncated : outputTruncated;
                if (truncated) return (null, true);
                try { return (StrictUtf8.GetString(target.GetBuffer(), 0, (int)target.Length), false); }
                catch (DecoderFallbackException) { return (null, false); }
            }
        }
    }

    public sealed class NativeResult
    {
        public int ExitCode { get; set; }
        public string Output { get; set; }
        internal NativeCapture Capture { get; set; }
        public string Diagnostic => Capture?.Snapshot(true).Text;
    }

    public sealed class HttpResult
    {
        public int Status { get; set; }
        public string RequestId { get; set; }
        public string Output { get; set; }
        public string ContentType { get; set; }
        public string Method { get; set; }
        public string ObservedAt { get; set; }
        public Dictionary<string, string> Headers { get; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public double? RetryAfterSeconds { get; set; }
        public string ClientRequestId { get; set; }
        public NativeCapture BodyCapture { get; } = new NativeCapture();
    }

    private static async Task<string> ReadTextAsync(
        Stream source, int limit, bool keepPrefix, CancellationToken token,
        NativeCapture capture = null, bool diagnostic = false)
    {
        var buffer = new byte[8192];
        using var content = new MemoryStream();
        int count;
        while ((count = await source.ReadAsync(buffer.AsMemory(), token).ConfigureAwait(false)) != 0)
        {
            capture?.Append(diagnostic, buffer, count);
            int remaining = limit - (int)content.Length;
            if (count > remaining && !keepPrefix)
                throw new OpenAiLocalOutputLimitException();
            content.Write(buffer, 0, Math.Min(count, remaining));
            if (count > remaining && capture == null && keepPrefix) break;
        }
        return (keepPrefix ? Encoding.UTF8 : StrictUtf8).GetString(content.GetBuffer(), 0, (int)content.Length);
    }

    private static async Task<bool> SendInputAsync(
        Process process, byte[] input, CancellationToken token)
    {
        using var pipe = process.StandardInput.BaseStream;
        try
        {
            if (input != null)
                await pipe.WriteAsync(input.AsMemory(), token).ConfigureAwait(false);
            return true;
        }
        catch (IOException)
        {
            // A child can exit with useful diagnostics before accepting stdin.
            return false;
        }
    }

    private static async Task DrainDiagnosticsAsync(Stream source, NativeCapture capture, CancellationToken token)
    {
        var buffer = new byte[8192];
        int count;
        while ((count = await source.ReadAsync(buffer.AsMemory(), token).ConfigureAwait(false)) != 0)
            capture.Append(true, buffer, count);
    }

    public static async Task<NativeResult> ReadNativeAsync(
        Process process, byte[] input, int outputLimit, CancellationToken token, NativeCapture capture)
    {
        var exit = process.WaitForExitAsync(token);
        var output = ReadTextAsync(process.StandardOutput.BaseStream, outputLimit, false, token,
                                   capture);
        var diagnostic = DrainDiagnosticsAsync(process.StandardError.BaseStream, capture, token);
        var sent = SendInputAsync(process, input, token);
        capture.IoCompletion = Task.WhenAll(output, diagnostic, sent);
        var pending = new List<Task> { exit, output, diagnostic, sent };
        while (pending.Count != 0)
        {
            var finished = await Task.WhenAny(pending).ConfigureAwait(false);
            await finished.ConfigureAwait(false);
            pending.Remove(finished);
        }
        if (process.ExitCode == 0 && input != null && !sent.Result)
            throw new IOException("The child closed stdin before consuming the request.");
        return new NativeResult
        {
            ExitCode = process.ExitCode, Output = output.Result, Capture = capture
        };
    }

    public static async Task<HttpResult> RequestAsync(
        Uri uri, string key, byte[] input, int outputLimit, CancellationToken token, HttpResult result)
    {
        using var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(60),
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate |
                                     DecompressionMethods.Brotli
        };
        using var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        using var request = new HttpRequestMessage(input == null ? HttpMethod.Get : HttpMethod.Post, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        request.Headers.Add("X-Client-Request-Id", result.ClientRequestId);
        if (input != null)
        {
            request.Content = new ByteArrayContent(input);
            request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse("application/json; charset=utf-8");
        }
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead,
                                                   token).ConfigureAwait(false);
        result.Status = (int)response.StatusCode;
        result.Method = request.Method.Method;
        result.ObservedAt = DateTimeOffset.UtcNow.ToString("o");
        foreach (var name in new[] { "x-request-id", "retry-after", "retry-after-ms",
                 "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests",
                 "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens",
                 "x-ratelimit-limit-project-tokens", "x-ratelimit-remaining-project-tokens", "x-ratelimit-reset-project-tokens",
                 "openai-organization", "openai-processing-ms" })
        {
            if (!response.Headers.TryGetValues(name, out var values)) continue;
            using var observed = values.GetEnumerator();
            if (!observed.MoveNext()) continue;
            var value = observed.Current;
            if (!observed.MoveNext() && (Regex.IsMatch(value, @"\A[A-Za-z0-9._ :+/-]{1,200}\z") ||
                (name == "retry-after" && DateTimeOffset.TryParseExact(value, "r",
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal, out _))))
                result.Headers[name] = value;
        }
        result.ContentType = response.Content.Headers.ContentType?.MediaType;
        if (response.Headers.TryGetValues("x-request-id", out var ids))
        {
            using var first = ids.GetEnumerator();
            if (first.MoveNext()) result.RequestId = first.Current;
        }
        var retry = response.Headers.RetryAfter;
        var delay = retry?.Delta ?? (retry?.Date - DateTimeOffset.UtcNow);
        if (delay.HasValue) result.RetryAfterSeconds = Math.Max(0, Math.Ceiling(delay.Value.TotalSeconds));
        try
        {
            using var body = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
            result.Output = await ReadTextAsync(body, response.IsSuccessStatusCode ? outputLimit : 64 * 1024,
                                                !response.IsSuccessStatusCode, token,
                                                response.IsSuccessStatusCode ? result.BodyCapture : null).ConfigureAwait(false);
        }
        catch (IOException) when (!response.IsSuccessStatusCode) { }
        return result;
    }
}
