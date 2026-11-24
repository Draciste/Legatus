using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class OpenAiWindowsCredentialV2 {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Read(string name, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredFree")]
    private static extern void Free(IntPtr credential);

    public static string Load() => LoadCredential("OpenAI API pro Codex");

    public static string LoadWorkspaceAgent() => LoadCredential("OpenAI Workspace Agents pro Codex");

    private static string LoadCredential(string target) {
        const uint generic = 1;
        IntPtr pointer;
        if (!Read(target, generic, 0, out pointer)) {
            int error = Marshal.GetLastWin32Error();
            if (error == 1168) return null;
            throw new Win32Exception(error);
        }
        try {
            Credential entry = Marshal.PtrToStructure<Credential>(pointer);
            if (entry.Blob == IntPtr.Zero || entry.BlobSize == 0 || entry.BlobSize % 2 != 0)
                return null;
            return Marshal.PtrToStringUni(entry.Blob, checked((int)entry.BlobSize / 2));
        } finally {
            Free(pointer);
        }
    }
}
