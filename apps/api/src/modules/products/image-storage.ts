import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { diskStorage } from "multer";
import { BadRequestException } from "@nestjs/common";

export const PRODUCT_IMAGE_ROOT = resolve(process.cwd(), "uploads", "products");

const ALLOWED_IMAGE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

// filenames are always server-generated random hex (never the client's original name) — this alone
// rules out path traversal, and the regex below is enforced again on the read side as defense-in-depth
const SAFE_FILENAME = /^[a-f0-9]{32}\.(jpg|png|webp|gif)$/;

export const productImageUploadOptions = {
  storage: diskStorage({
    destination: (_req: unknown, _file: Express.Multer.File, cb: (error: Error | null, dest: string) => void) => {
      if (!existsSync(PRODUCT_IMAGE_ROOT)) mkdirSync(PRODUCT_IMAGE_ROOT, { recursive: true });
      cb(null, PRODUCT_IMAGE_ROOT);
    },
    filename: (_req: unknown, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
      const ext = ALLOWED_IMAGE_EXT[file.mimetype];
      cb(null, `${randomBytes(16).toString("hex")}${ext ?? ""}`);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (_req: unknown, file: Express.Multer.File, cb: (error: Error | null, accept: boolean) => void) => {
    if (ALLOWED_IMAGE_EXT[file.mimetype]) cb(null, true);
    else cb(new BadRequestException("Only JPEG, PNG, WEBP, or GIF images are supported."), false);
  },
};

export function resolveProductImagePath(filename: string): string {
  if (!SAFE_FILENAME.test(filename)) throw new BadRequestException("Invalid image path.");
  return join(PRODUCT_IMAGE_ROOT, filename);
}

/**
 * Stored on Product.imageUrl as a relative path (never an absolute origin) — the web dashboard and the
 * WhatsApp/Instagram sender need DIFFERENT absolute origins to reach it (localhost vs. a public tunnel/domain
 * when the dev machine can't "loop back" to its own public ngrok URL), so each resolves it at read/send time.
 */
export function buildProductImageUrl(filename: string): string {
  return `/api/uploads/products/${filename}`;
}

/** Resolves a relative Product.imageUrl into a publicly-fetchable absolute URL for WhatsApp/Instagram to download. */
export function toPublicImageUrl(imageUrl: string): string {
  if (/^https?:\/\//i.test(imageUrl)) return imageUrl; // already absolute (legacy rows, or an external URL)
  const base = process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
  return `${base}${imageUrl}`;
}

/** Best-effort delete of the previous image file when a product's image is replaced. */
export function deleteProductImageFile(imageUrl: string | null): void {
  if (!imageUrl) return;
  const filename = imageUrl.split("/").pop();
  if (!filename || !SAFE_FILENAME.test(filename)) return;
  try {
    const filePath = join(PRODUCT_IMAGE_ROOT, filename);
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch { /* best-effort cleanup — a stray file on disk is not worth failing the request over */ }
}
