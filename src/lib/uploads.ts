import { z } from "zod";

/**
 * Files sent as JSON (`[{ name, type, data }]`, data in base64): a receipt's
 * photo, a lab's report. The bytes decide what a file is, never the client's
 * word for it, and only the types a caller allows are kept. Each file is
 * checked for its size before it is decoded.
 */

export interface FileUpload {
  name: string | null;
  mimeType: string;
  bytes: Buffer;
}

/** The photos a phone or a scanner makes, and PDF. */
export const DOCUMENT_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);

export class UploadError extends Error {
  constructor(
    readonly code: "file_type" | "file_too_large" | "too_many_files",
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/** The type from the first bytes, or null. */
export function sniffFileType(bytes: Uint8Array): string | null {
  const b = (i: number) => bytes[i] ?? -1;
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (b(0) === 0x89 && ascii(1, 4) === "PNG" && b(4) === 0x0d && b(5) === 0x0a) return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heif"].includes(brand)) return "image/heif";
  }
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  return null;
}

const FilePayload = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  type: z.string().trim().max(80).nullable().optional(),
  /** Base64, with or without a `data:…;base64,` prefix. */
  data: z.string().min(1),
});

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;
const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** The files of a request, typed by their bytes; throws an `UploadError` the page can explain. */
export function parseFilePayload(raw: unknown, opts: { max: number; maxBytes: number; types?: ReadonlySet<string> }): FileUpload[] {
  const types = opts.types ?? DOCUMENT_TYPES;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new UploadError("file_type", "Files must be a list.");
  if (raw.length > opts.max) throw new UploadError("too_many_files", `At most ${opts.max} files at a time.`);
  return raw.map((item) => {
    const parsed = FilePayload.safeParse(item);
    if (!parsed.success) throw new UploadError("file_type", "A file could not be read.");
    const data = parsed.data.data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    // Refuse before decoding anything obviously too big (4 base64 characters carry 3 bytes).
    if (Math.floor((data.length * 3) / 4) > opts.maxBytes + 3) throw new UploadError("file_too_large", `Each file must be ${megabytes(opts.maxBytes)} or smaller.`);
    if (!BASE64.test(data)) throw new UploadError("file_type", "A file could not be read.");
    const bytes = Buffer.from(data, data.includes("-") || data.includes("_") ? "base64url" : "base64");
    if (!bytes.length) throw new UploadError("file_type", "An empty file was sent.");
    if (bytes.length > opts.maxBytes) throw new UploadError("file_too_large", `Each file must be ${megabytes(opts.maxBytes)} or smaller.`);
    const mimeType = sniffFileType(bytes);
    if (!mimeType || !types.has(mimeType)) throw new UploadError("file_type", "Files must be a photo (JPEG, PNG, WebP or HEIC) or a PDF.");
    const name = parsed.data.name?.replace(/[\\/\r\n\t"]/g, " ").trim().slice(0, 120) || null;
    return { name, mimeType, bytes };
  });
}
