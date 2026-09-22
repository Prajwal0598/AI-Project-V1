import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import type { Response } from "express";
import { FileInterceptor } from "@nestjs/platform-express";
import { GetUser } from "../../common/get-user.decorator";
import { Public } from "../auth/public.decorator";
import { PromotionService } from "./promotion.service";
import { CreatePromotionDto } from "./dto/create-promotion.dto";
import { buildPromotionImageUrl, promotionImageUploadOptions, resolvePromotionImagePath } from "./promotion-image-storage";

@Controller()
export class PromotionController {
  constructor(private readonly promotions: PromotionService) {}

  @Get("businesses/:businessId/promotions")
  list(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.promotions.list(businessId);
  }

  @Post("businesses/:businessId/promotions")
  create(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }, @Body() input: CreatePromotionDto) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.promotions.create(businessId, input);
  }

  @Post("promotions/:id/broadcast")
  broadcast(@Param("id") id: string, @GetUser() user: { businessId: string }) {
    return this.promotions.broadcast(id, user.businessId);
  }

  @Delete("promotions/:id")
  remove(@Param("id") id: string, @GetUser() user: { businessId: string }) {
    return this.promotions.remove(id, user.businessId);
  }

  @Post("promotions/:id/image")
  @UseInterceptors(FileInterceptor("image", promotionImageUploadOptions))
  async uploadImage(@Param("id") id: string, @GetUser() user: { businessId: string }, @UploadedFile() file: Express.Multer.File) {
    const imageUrl = buildPromotionImageUrl(file.filename);
    return this.promotions.setImage(id, user.businessId, imageUrl);
  }

  @Public()
  @Get("uploads/promotions/:filename")
  serveImage(@Param("filename") filename: string, @Res() res: Response) {
    let filePath: string;
    try { filePath = resolvePromotionImagePath(filename); } catch { throw new NotFoundException(); }
    res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
  }
}
