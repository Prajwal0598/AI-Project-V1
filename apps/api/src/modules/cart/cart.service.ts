import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { CartStatus, OrderStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { OrderService } from "../orders/order.service";
import type { OrderItemInputDto } from "../orders/dto/create-order.dto";

const CART_INCLUDE = { items: { include: { variant: { include: { product: true } } } } };
// an order can still be amended (items replaced) up until it's paid — mirrors ai.service.ts's AMENDABLE_STATUSES
const AMENDABLE_STATUSES = new Set<OrderStatus>([OrderStatus.DRAFT, OrderStatus.AWAITING_APPROVAL, OrderStatus.PENDING_PAYMENT]);

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
  ) {}

  /** Returns the conversation's active cart, creating a fresh one if none exists (or the last one was checked out). */
  async getOrCreateActive(conversationId: string, businessId: string, customerId: string) {
    const existing = await this.prisma.cart.findFirst({ where: { conversationId, businessId, status: CartStatus.ACTIVE }, include: CART_INCLUDE });
    if (existing) return existing;
    return this.prisma.cart.create({ data: { businessId, conversationId, customerId }, include: CART_INCLUDE });
  }

  /** Like getOrCreateActive, but never creates one — used by the free-text AI flow to check for cart items to merge in without conjuring an empty cart. */
  async findActiveForConversation(conversationId: string, businessId: string) {
    return this.prisma.cart.findFirst({ where: { conversationId, businessId, status: CartStatus.ACTIVE }, include: CART_INCLUDE });
  }

  async get(cartId: string, businessId: string) {
    const cart = await this.prisma.cart.findFirst({ where: { id: cartId, businessId }, include: CART_INCLUDE });
    if (!cart) throw new NotFoundException("Cart not found.");
    return cart;
  }

  /** Adds a variant to the cart, or increments quantity if it's already in there. Validates stock when tracked. */
  async addItem(cartId: string, businessId: string, variantId: string, quantity: number) {
    const cart = await this.prisma.cart.findFirst({ where: { id: cartId, businessId } });
    if (!cart) throw new NotFoundException("Cart not found.");
    const variant = await this.prisma.variant.findFirst({ where: { id: variantId, businessId, active: true } });
    if (!variant) throw new NotFoundException("Product variant not found.");

    const existingItem = await this.prisma.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId } } });
    const newQuantity = (existingItem?.quantity ?? 0) + quantity;
    if (variant.inventory !== null && newQuantity > variant.inventory) {
      throw new BadRequestException(`Only ${variant.inventory} left in stock.`);
    }

    await this.prisma.cartItem.upsert({
      where: { cartId_variantId: { cartId, variantId } },
      create: { cartId, variantId, quantity },
      update: { quantity: newQuantity },
    });
    return this.get(cartId, businessId);
  }

  async updateItemQuantity(cartId: string, businessId: string, variantId: string, quantity: number) {
    const cart = await this.prisma.cart.findFirst({ where: { id: cartId, businessId } });
    if (!cart) throw new NotFoundException("Cart not found.");
    if (quantity <= 0) {
      await this.prisma.cartItem.deleteMany({ where: { cartId, variantId } });
    } else {
      const variant = await this.prisma.variant.findFirst({ where: { id: variantId, businessId } });
      if (variant?.inventory !== null && variant !== null && quantity > variant.inventory) {
        throw new BadRequestException(`Only ${variant.inventory} left in stock.`);
      }
      await this.prisma.cartItem.updateMany({ where: { cartId, variantId }, data: { quantity } });
    }
    return this.get(cartId, businessId);
  }

  async clear(cartId: string, businessId: string) {
    const cart = await this.prisma.cart.findFirst({ where: { id: cartId, businessId } });
    if (!cart) throw new NotFoundException("Cart not found.");
    await this.prisma.cartItem.deleteMany({ where: { cartId } });
    return this.get(cartId, businessId);
  }

  totals(cart: Awaited<ReturnType<CartService["get"]>>) {
    const subtotal = cart.items.reduce((sum, item) => sum + Number(item.variant.price) * item.quantity, 0);
    const currency = cart.items[0]?.variant.currency ?? "INR";
    return { subtotal, currency, itemCount: cart.items.reduce((sum, i) => sum + i.quantity, 0) };
  }

  /** Converts a cart into a real Order (reusing OrderService's stock reservation), marks the cart CHECKED_OUT.
   * If the conversation already has an amendable order (e.g. started via the free-text AI flow), merges into
   * that order instead of creating a second overlapping one. */
  async checkout(cartId: string, businessId: string, input: { shippingAddress: string; paymentMethod: "UPI" | "COD" }) {
    const cart = await this.get(cartId, businessId);
    if (cart.status !== CartStatus.ACTIVE) throw new BadRequestException("This cart has already been checked out.");
    if (!cart.items.length) throw new BadRequestException("Your cart is empty.");

    const cartOrderItems: OrderItemInputDto[] = cart.items.map((item) => {
      const attrs = item.variant.attributes as Record<string, string> | null;
      const attrSuffix = attrs ? ` (${Object.values(attrs).join(", ")})` : "";
      return {
        productId: item.variant.productId,
        variantId: item.variantId,
        name: `${item.variant.product.name}${attrSuffix}`,
        quantity: item.quantity,
        unitPrice: Number(item.variant.price),
      };
    });

    const conversation = await this.prisma.conversation.findUnique({ where: { id: cart.conversationId } });
    const activeOrder = conversation?.activeOrderId
      ? await this.prisma.order.findFirst({ where: { id: conversation.activeOrderId, businessId }, include: { items: true } })
      : null;
    const isAmendment = !!activeOrder && AMENDABLE_STATUSES.has(activeOrder.status);

    const order = isAmendment
      ? await this.orders.replaceItems(activeOrder!.id, businessId, this.mergeItems(activeOrder!.items, cartOrderItems), { address: input.shippingAddress })
      : await this.orders.create(businessId, {
          customerId: cart.customerId,
          conversationId: cart.conversationId,
          subtotal: this.totals(cart).subtotal,
          currency: this.totals(cart).currency,
          shippingAddress: { address: input.shippingAddress },
          paymentMethod: input.paymentMethod,
          items: cartOrderItems,
        });

    await this.prisma.cart.update({ where: { id: cartId }, data: { status: CartStatus.CHECKED_OUT } });
    return order;
  }

  /** Merges two item lists by variantId (summing quantities), so amending an order never silently drops what's already on it. */
  private mergeItems(existing: { productId: string | null; variantId: string | null; name: string; quantity: number; unitPrice: unknown }[], additions: OrderItemInputDto[]): OrderItemInputDto[] {
    const merged = new Map<string, OrderItemInputDto>();
    for (const item of existing) {
      const key = item.variantId ?? item.name;
      merged.set(key, { productId: item.productId ?? undefined, variantId: item.variantId ?? undefined, name: item.name, quantity: item.quantity, unitPrice: Number(item.unitPrice) });
    }
    for (const item of additions) {
      const key = item.variantId ?? item.name;
      const existingEntry = merged.get(key);
      merged.set(key, existingEntry ? { ...existingEntry, quantity: existingEntry.quantity + item.quantity } : item);
    }
    return Array.from(merged.values());
  }
}
