import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import type { Response } from "express";
import { FileInterceptor } from "@nestjs/platform-express";
import type { User } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { Public } from "../auth/public.decorator";
import { ProductService } from "./product.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { UpdateVariantDto } from "./dto/update-variant.dto";
import { BulkUpdateProductsDto } from "./dto/bulk-update-products.dto";
import { buildProductImageUrl, productImageUploadOptions, resolveProductImagePath } from "./image-storage";

@Controller()
export class ProductController {
  constructor(private readonly products: ProductService) {}

  @Get("businesses/:businessId/products")
  findAll(@Param("businessId") businessId: string, @GetUser() user: User) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.products.findAll(businessId);
  }

  @Post("businesses/:businessId/products")
  create(@Param("businessId") businessId: string, @GetUser() user: User, @Body() input: CreateProductDto) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.products.create(businessId, input);
  }

  @Patch("businesses/:businessId/products/bulk")
  bulkUpdate(@Param("businessId") businessId: string, @GetUser() user: User, @Body() input: BulkUpdateProductsDto) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.products.bulkUpdate(businessId, input);
  }

  @Patch("products/:productId")
  update(@Param("productId") productId: string, @GetUser() user: User, @Body() input: UpdateProductDto) {
    return this.products.update(productId, user.businessId, input);
  }

  @Delete("products/:productId")
  remove(@Param("productId") productId: string, @GetUser() user: User) {
    return this.products.remove(productId, user.businessId);
  }

  @Patch("variants/:variantId")
  updateVariant(@Param("variantId") variantId: string, @GetUser() user: User, @Body() input: UpdateVariantDto) {
    return this.products.updateVariant(variantId, user.businessId, input);
  }

  @Post("products/:productId/image")
  @UseInterceptors(FileInterceptor("image", productImageUploadOptions))
  async uploadImage(@Param("productId") productId: string, @GetUser() user: User, @UploadedFile() file: Express.Multer.File) {
    const imageUrl = buildProductImageUrl(file.filename);
    return this.products.setImage(productId, user.businessId, imageUrl);
  }

  @Public()
  @Get("uploads/products/:filename")
  serveImage(@Param("filename") filename: string, @Res() res: Response) {
    let filePath: string;
    try { filePath = resolveProductImagePath(filename); } catch { throw new NotFoundException(); }
    res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
  }
}
