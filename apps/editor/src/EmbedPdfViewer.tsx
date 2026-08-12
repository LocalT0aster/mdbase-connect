import { PDFViewer } from "@embedpdf/react-pdf-viewer";

export function EmbedPdfViewer({ src, filename }: { src: string; filename: string }) {
  return (
    <div className="embedpdf-viewer" aria-label={`PDF viewer, ${filename}`}>
      <PDFViewer
        config={{
          src,
          tabBar: "never",
          theme: { preference: "system" },
          fonts: {
            ui: {
              family: '"Atkinson Hyperlegible", system-ui, sans-serif',
              stylesheetUrl: null
            },
            signature: null
          },
          disabledCategories: [
            "annotation",
            "form",
            "redaction",
            "insert",
            "history",
            "document-open",
            "document-close"
          ]
        }}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
