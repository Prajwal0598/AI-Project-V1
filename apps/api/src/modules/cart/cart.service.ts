import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { CartStatus, OrderStatus, ProductStatus } from "@prisma/client";
import { PrismaService } from "../../database/prisma.service";
import { OrderService } from "../orders/order.service";
import type { OrderItemInputDto } from "../orders/dto/create-order.dto";
import { QueueService } from "../../queue/queue.service";
import { OpportunityService } from "../opportunities/opportunity.service";
import { captureException } from "../../common/error-reporting.helper";

const CART_INCLUDE = { items: { include: { variant: { include: { product: true } } } } };
// an order can still be amended (items replaced) up until it's paid — mirrors ai.service.ts's AMENDABLE_STATUSES
const AMENDABLE_STATUSES = new Set<OrderStatus>([OrderStatus.DRAFT, OrderStatus.AWAITING_APPROVAL, OrderStatus.PENDING_PAYMENT]);

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly queues: QueueService,
    private readonly opportunities: OpportunityService,
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
    // an id from a stale button or an old list must resolve to a real, purchasable record: an active variant of a PUBLISHED product
    const variant = await this.prisma.variant.findFirst({ where: { id: variantId, businessId, active: true, product: { status: ProductStatus.PUBLISHED } } });
    if (!variant) throw new NotFoundException("That item is no longer available.");

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
    await this.queues.scheduleAbandonedCartFollowUp(cartId, businessId, cart.customerId);
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
    const updated = await this.get(cartId, businessId);
    if (updated.items.length) await this.queues.scheduleAbandonedCartFollowUp(cartId, businessId, cart.customerId);
    else await this.queues.cancelAbandonedCartFollowUp(cartId);
    return updated;
  }

  async clear(cartId: string, businessId: string) {
    const cart = await this.prisma.cart.findFirst({ where: { id: cartId, businessId } });
    if (!cart) throw new NotFoundException("Cart not found.");
    await this.prisma.cartItem.deleteMany({ where: { cartId } });
    await this.queues.cancelAbandonedCartFollowUp(cartId);
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
  async checkout(cartId: string, businessId: string, input: { shippingAddress: string; paymentMethod: "UPI" | "COD" | "CARD" }) {
    const cart = await this.get(cartId, businessId);
    if (cart.status !== CartStatus.ACTIVE) throw new ConflictException("This cart has already been checked out.");
    if (!cart.items.length) throw new BadRequestException("Your cart is empty.");

    // an item hidden or switched off since it was added can't be ordered — say which, rather than failing deep inside order creation
    const unavailable = cart.items.filter((item) => !item.variant.active || item.variant.product.status !== ProductStatus.PUBLISHED).map((item) => item.variant.product.name);
    if (unavailable.length) {
      throw new BadRequestException(`${Array.from(new Set(unavailable)).join(", ")} ${unavailable.length === 1 ? "is" : "are"} no longer available. Please remove ${unavailable.length === 1 ? "it" : "them"} from your cart to continue.`);
    }

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

    // claim the cart atomically BEFORE creating anything: of any number of simultaneous confirmations (a double tap
    // delivered as two different WhatsApp messages) exactly one wins, so one cart can never become two orders
    const latestOrderId = async () => (await this.prisma.order.findFirst({ where: { businessId, conversationId: cart.conversationId }, orderBy: { createdAt: "desc" }, select: { id: true } }))?.id ?? null;
    const latestBefore = isAmendment ? null : await latestOrderId();
    const claimed = await this.prisma.cart.updateMany({ where: { id: cartId, businessId, status: CartStatus.ACTIVE }, data: { status: CartStatus.CHECKED_OUT } });
    if (claimed.count === 0) throw new ConflictException("This cart has already been checked out.");

    let order;
    try {
      order = isAmendment
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
    } catch (err) {
      // Validation and stock failures (HTTP errors) are raised before anything is committed. Any other failure may have
      // happened AFTER the order was committed (a queue or follow-up step), so look before reopening the cart: reopening
      // over a committed order would let the customer's retry place it a second time.
      if (!(err instanceof HttpException) && !isAmendment) {
        let committed: Awaited<ReturnType<CartService["orderCommittedSince"]>>;
        try {
          committed = await this.orderCommittedSince(businessId, cart.conversationId, latestBefore);
        } catch {
          throw err; // cannot tell — leave the cart closed rather than risk a duplicate order
        }
        if (committed) {
          this.logger.error(`Order ${committed.id} was placed but a follow-up step failed for cart ${cartId}: ${err instanceof Error ? err.message : String(err)}`);
          captureException(err, { cartId, businessId, orderId: committed.id });
          order = committed;
        }
      }
      if (!order) {
        // the order was not placed (e.g. stock ran out) — give the cart back so the customer can adjust it and retry
        await this.prisma.cart.updateMany({ where: { id: cartId, businessId }, data: { status: CartStatus.ACTIVE } });
        throw err;
      }
    }

    await this.opportunities.expireForCheckedOutCart(businessId, cartId);
    await this.queues.cancelAbandonedCartFollowUp(cartId);
    return order;
  }

  /** The conversation's newest order when it is different from the one that was newest before this checkout began, else null. */
  private async orderCommittedSince(businessId: string, conversationId: string, latestBefore: string | null) {
    const latest = await this.prisma.order.findFirst({ where: { businessId, conversationId }, orderBy: { createdAt: "desc" } });
    return latest && latest.id !== latestBefore ? latest : null;
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
