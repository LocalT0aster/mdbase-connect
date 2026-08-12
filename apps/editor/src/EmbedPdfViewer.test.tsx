import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmbedPdfViewer } from "./EmbedPdfViewer";

const { pdfViewer } = vi.hoisted(() => ({ pdfViewer: vi.fn(() => null) }));

vi.mock("@embedpdf/react-pdf-viewer", () => ({ PDFViewer: pdfViewer }));

describe("EmbedPdfViewer", () => {
  it("uses local UI fonts without weakening the editor content policy", () => {
    render(<EmbedPdfViewer src="blob:document" filename="paper.pdf" />);

    expect(pdfViewer).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          src: "blob:document",
          fonts: {
            ui: {
              family: '"Atkinson Hyperlegible", system-ui, sans-serif',
              stylesheetUrl: null
            },
            signature: null
          }
        })
      }),
      undefined
    );
  });
});
