import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CartService } from "./cart.service";
import type { PrismaService } from "../../database/prisma.service";
import type { OrderService } from "../orders/order.service";
import type { QueueService } from "../../queue/queue.service";

describe("CartService.addItem — stock validation", () => {
  let prisma: any;
  let queues: { scheduleAbandonedCartFollowUp: jest.Mock; cancelAbandonedCartFollowUp: jest.Mock };
  let cartService: CartService;

  beforeEach(() => {
    prisma = {
      cart: { findFirst: jest.fn().mockResolvedValue({ id: "cart1", customerId: "cust1" }) },
      variant: { findFirst: jest.fn() },
      cartItem: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    };
    queues = { scheduleAbandonedCartFollowUp: jest.fn(), cancelAbandonedCartFollowUp: jest.fn() };
    cartService = new CartService(prisma as unknown as PrismaService, {} as unknown as OrderService, queues as unknown as QueueService);
  });

  it("throws if the cart doesn't exist", async () => {
    prisma.cart.findFirst.mockResolvedValue(null);
    await expect(cartService.addItem("missing", "biz1", "v1", 1)).rejects.toThrow(NotFoundException);
  });

  it("throws if the variant doesn't exist (or isn't active/owned by this business)", async () => {
    prisma.variant.findFirst.mockResolvedValue(null);
    await expect(cartService.addItem("cart1", "biz1", "missing-variant", 1)).rejects.toThrow(NotFoundException);
  });

  it("adds a new item within stock limits", async () => {
    prisma.variant.findFirst.mockResolvedValue({ id: "v1", inventory: 10 });
    prisma.cartItem.upsert.mockResolvedValue({});
    prisma.cart.findFirst.mockResolvedValueOnce({ id: "cart1", customerId: "cust1" }).mockResolvedValueOnce({ id: "cart1", customerId: "cust1", items: [] });
    await cartService.addItem("cart1", "biz1", "v1", 3);
    expect(prisma.cartItem.upsert).toHaveBeenCalledWith({
      where: { cartId_variantId: { cartId: "cart1", variantId: "v1" } },
      create: { cartId: "cart1", variantId: "v1", quantity: 3 },
      update: { quantity: 3 },
    });
  });

  it("rejects when the requested quantity exceeds tracked stock", async () => {
    prisma.variant.findFirst.mockResolvedValue({ id: "v1", inventory: 2 });
    await expect(cartService.addItem("cart1", "biz1", "v1", 5)).rejects.toThrow("Only 2 left in stock.");
    expect(prisma.cartItem.upsert).not.toHaveBeenCalled();
  });

  it("adds to an EXISTING cart item's quantity when checking the stock limit (not just the new amount)", async () => {
    prisma.variant.findFirst.mockResolvedValue({ id: "v1", inventory: 5 });
    prisma.cartItem.findUnique.mockResolvedValue({ quantity: 3 }); // already 3 in cart
    // adding 3 more (total 6) exceeds the 5 in stock, even though 3 alone would be fine
    await expect(cartService.addItem("cart1", "biz1", "v1", 3)).rejects.toThrow("Only 5 left in stock.");
  });

  it("never rejects for untracked stock (inventory: null), regardless of quantity", async () => {
    prisma.variant.findFirst.mockResolvedValue({ id: "v1", inventory: null });
    prisma.cartItem.upsert.mockResolvedValue({});
    prisma.cart.findFirst.mockResolvedValueOnce({ id: "cart1", customerId: "cust1" }).mockResolvedValueOnce({ id: "cart1", customerId: "cust1", items: [] });
    await expect(cartService.addItem("cart1", "biz1", "v1", 9999)).resolves.toBeDefined();
  });

  it("schedules an abandoned-cart nudge after a successful add", async () => {
    prisma.variant.findFirst.mockResolvedValue({ id: "v1", inventory: 10 });
    prisma.cartItem.upsert.mockResolvedValue({});
    prisma.cart.findFirst.mockResolvedValueOnce({ id: "cart1", customerId: "cust1" }).mockResolvedValueOnce({ id: "cart1", customerId: "cust1", items: [] });
    await cartService.addItem("cart1", "biz1", "v1", 1);
    expect(queues.scheduleAbandonedCartFollowUp).toHaveBeenCalledWith("cart1", "biz1", "cust1");
  });
});

describe("CartService.updateItemQuantity", () => {
  let prisma: any;
  let queues: { scheduleAbandonedCartFollowUp: jest.Mock; cancelAbandonedCartFollowUp: jest.Mock };
  let cartService: CartService;

  beforeEach(() => {
    prisma = {
      cart: { findFirst: jest.fn().mockResolvedValue({ id: "cart1", customerId: "cust1" }) },
      variant: { findFirst: jest.fn() },
      cartItem: { deleteMany: jest.fn(), updateMany: jest.fn() },
    };
    queues = { scheduleAbandonedCartFollowUp: jest.fn(), cancelAbandonedCartFollowUp: jest.fn() };
    cartService = new CartService(prisma as unknown as PrismaService, {} as unknown as OrderService, queues as unknown as QueueService);
  });

  it("removes the item entirely when quantity is set to 0 or below", async () => {
    prisma.cart.findFirst.mockResolvedValueOnce({ id: "cart1", customerId: "cust1" }).mockResolvedValueOnce({ id: "cart1", customerId: "cust1", items: [] });
    await cartService.updateItemQuantity("cart1", "biz1", "v1", 0);
    expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({ where: { cartId: "cart1", variantId: "v1" } });
    expect(queues.cancelAbandonedCartFollowUp).toHaveBeenCalledWith("cart1");
  });

  it("rejects a quantity update that exceeds tracked stock", async () => {
    prisma.variant.findFirst.mockResolvedValue({ id: "v1", inventory: 4 });
    await expect(cartService.updateItemQuantity("cart1", "biz1", "v1", 10)).rejects.toThrow(BadRequestException);
    expect(prisma.cartItem.updateMany).not.toHaveBeenCalled();
  });
});
