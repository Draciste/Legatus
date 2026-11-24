const extensions = {
    pdf: 'pdf-visual-and-text',
    xls: 'spreadsheet-prefix-augmentation', xlsx: 'spreadsheet-prefix-augmentation',
    xlsm: 'spreadsheet-prefix-augmentation', xlsb: 'spreadsheet-prefix-augmentation',
    xltx: 'spreadsheet-prefix-augmentation', ods: 'spreadsheet-prefix-augmentation',
    csv: 'spreadsheet-prefix-augmentation', tsv: 'spreadsheet-prefix-augmentation',
    doc: 'document-text-only', docx: 'document-text-only', ppt: 'document-text-only',
    pptx: 'document-text-only', odt: 'document-text-only', odp: 'document-text-only',
    rtf: 'document-text-only',
};

export function describeFileInputs(input) {
    const items = Array.isArray(input) ? input : input?.type ? [input] : [];
    const modes = new Map();
    for (const item of items) {
        const parts = Array.isArray(item?.content) ? item.content : [item];
        for (const part of parts) {
            if (part?.type !== 'input_file') continue;
            let filename = typeof part.filename === 'string' ? part.filename : '';
            if (!filename && typeof part.file_url === 'string') {
                try { filename = new URL(part.file_url).pathname; } catch {}
            }
            const suffix = /\.([a-z0-9]{1,12})$/i.exec(filename)?.[1].toLowerCase();
            const mode = Object.hasOwn(extensions, suffix) ? extensions[suffix] : 'unknown';
            modes.set(mode, (modes.get(mode) ?? 0) + 1);
        }
    }
    return modes.size ? { scope: 'request format cues, coverage not measured',
        formats: [...modes].map(([mode, count]) => ({mode, count})),
        guide: 'https://developers.openai.com/api/docs/guides/file-inputs' } : undefined;
}
