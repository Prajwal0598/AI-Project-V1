import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { diskStorage } from "multer";
import { BadRequestException } from "@nestjs/common";

export const PROMOTION_IMAGE_ROOT = resolve(process.cwd(), "uploads", "promotions");

// same two formats as product images — WhatsApp's Cloud API image-message type only renders JPEG/PNG
const ALLOWED_IMAGE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

// server-generated random hex filenames only — rules out path traversal; re-checked on the read side too
const SAFE_FILENAME = /^[a-f0-9]{32}\.(jpg|png)$/;

export const promotionImageUploadOptions = {
  storage: diskStorage({
    destination: (_req: unknown, _file: Express.Multer.File, cb: (error: Error | null, dest: string) => void) => {
      if (!existsSync(PROMOTION_IMAGE_ROOT)) mkdirSync(PROMOTION_IMAGE_ROOT, { recursive: true });
      cb(null, PROMOTION_IMAGE_ROOT);
    },
    filename: (_req: unknown, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
      const ext = ALLOWED_IMAGE_EXT[file.mimetype];
      cb(null, `${randomBytes(16).toString("hex")}${ext ?? ""}`);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (_req: unknown, file: Express.Multer.File, cb: (error: Error | null, accept: boolean) => void) => {
    if (ALLOWED_IMAGE_EXT[file.mimetype]) cb(null, true);
    else cb(new BadRequestException("Only JPEG or PNG images are supported (required for WhatsApp delivery)."), false);
  },
};

export function resolvePromotionImagePath(filename: string): string {
  if (!SAFE_FILENAME.test(filename)) throw new BadRequestException("Invalid image path.");
  return join(PROMOTION_IMAGE_ROOT, filename);
}

/** Stored on Promotion.imageUrl as a relative path — resolved to an absolute, publicly-fetchable URL at send time. */
export function buildPromotionImageUrl(filename: string): string {
  return `/api/uploads/promotions/${filename}`;
}

/** Best-effort delete of the previous uploaded file when a promotion's image is replaced. */
export function deletePromotionImageFile(imageUrl: string | null): void {
  if (!imageUrl) return;
  const filename = imageUrl.split("/").pop();
  if (!filename || !SAFE_FILENAME.test(filename)) return; // e.g. a copied product photo URL, not our own upload — never delete those
  try {
    const filePath = join(PROMOTION_IMAGE_ROOT, filename);
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch { /* best-effort cleanup — a stray file on disk is not worth failing the request over */ }
}
