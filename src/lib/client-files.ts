/**
 * Getting a file from the page to the API (browser only): photos decoded,
 * turned upright and shrunk to a JPEG before they go, PDFs as they are, both
 * in base64 for a JSON body.
 */

/** Decode, orient and shrink a photo to `maxSide` px as JPEG; null when this browser cannot decode it (e.g. HEIC on Chrome). */
export async function downscaleImage(file: File, maxSide: number): Promise<Blob | null> {
  let width = 0;
  let height = 0;
  let source: CanvasImageSource | null = null;
  let cleanup = () => {};
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      source = bitmap;
      width = bitmap.width;
      height = bitmap.height;
      cleanup = () => bitmap.close();
    } else {
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("decode"));
        img.src = url;
      });
      source = img;
      width = img.naturalWidth;
      height = img.naturalHeight;
      cleanup = () => URL.revokeObjectURL(url);
    }
    if (!width || !height) return null;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85));
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

/** A blob's bytes in base64, without the `data:` prefix. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("read"));
    reader.readAsDataURL(blob);
  });
}

export interface PreparedFile {
  name: string;
  type: string;
  data: string;
  bytes: number;
  /** A preview the page shows (photos the browser can draw); revoke it when done. */
  previewUrl: string | null;
}

/**
 * A photo or a PDF ready to send: a photo shrunk to `maxSide` (or sent as it
 * is when this browser cannot draw it, like HEIC on most Android browsers),
 * a PDF as it is. "too_large" or "unreadable" when it cannot go.
 */
export async function prepareFile(file: File, limits: { maxSide: number; maxBytes: number }): Promise<PreparedFile | "too_large" | "unreadable"> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  let blob: Blob;
  let type: string;
  if (isPdf) {
    blob = file;
    type = "application/pdf";
  } else {
    const shrunk = file.type.startsWith("image/") || !file.type ? await downscaleImage(file, limits.maxSide) : null;
    if (shrunk) {
      blob = shrunk;
      type = "image/jpeg";
    } else if (/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type || "image/heic")) {
      blob = file;
      type = file.type || "image/heic";
    } else {
      return "unreadable";
    }
  }
  if (blob.size > limits.maxBytes) return "too_large";
  const data = await blobToBase64(blob);
  const previewUrl = /^image\/(jpeg|png|webp)$/.test(type) ? URL.createObjectURL(blob) : null;
  return { name: file.name.slice(0, 100), type, data, bytes: blob.size, previewUrl };
}
