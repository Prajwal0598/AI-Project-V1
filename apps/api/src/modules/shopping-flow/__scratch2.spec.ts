import { ShoppingFlowService } from "./shopping-flow.service";
import type { PrismaService } from "../../database/prisma.service";
import type { ConversationService } from "../conversations/conversation.service";
import type { CartService } from "../cart/cart.service";
import type { OrderService } from "../orders/order.service";
import type { CustomerSignalService } from "../customer-signals/customer-signal.service";

describe("scratch trace quantity understanding - full flow", () => {
  it("traces what actually happens today across all 4 messages", async () => {
    const tshirt = { id: "p1", name: "Premium Cotton T-Shirt", description: null, brand: null, category: { name: "Fashion" }, variants: [{ id: "v1", price: 899, currency: "INR", inventory: 20 }] };
    const prisma: any = {
      business: { findUnique: jest.fn().mockResolvedValue({ id: "biz1", name: "Test Biz" }) },
      conversation: { findFirst: jest.fn(), update: jest.fn() },
      category: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([tshirt]), findFirst: jest.fn() },
      variant: { findFirst: jest.fn() },
    };
    const conversations: any = { sendButtons: jest.fn(), sendList: jest.fn(), sendMessage: jest.fn(), sendImage: jest.fn() };
    const cart: any = {
      getOrCreateActive: jest.fn().mockResolvedValue({ id: "cart1", items: [] }),
      findActiveForConversation: jest.fn(),
      addItem: jest.fn().mockResolvedValue({ items: [{ variantId: "v1", quantity: 2, variant: { price: 899, currency: "INR", product: { id: "p1", name: "Premium Cotton T-Shirt" } } }] }),
      updateItemQuantity: jest.fn().mockResolvedValue({ items: [{ variantId: "v1", quantity: 5, variant: { price: 899, currency: "INR", product: { id: "p1", name: "Premium Cotton T-Shirt" } } }] }),
      totals: jest.fn().mockImplementation((c: any) => ({ subtotal: c.items.reduce((s: number, i: any) => s + i.variant.price * i.quantity, 0), currency: "INR" })),
    };
    const orders: any = {};
    const signals: any = { record: jest.fn() };
    const flow = new ShoppingFlowService(prisma as unknown as PrismaService, conversations as unknown as ConversationService, cart as unknown as CartService, orders as unknown as OrderService, signals as unknown as CustomerSignalService);

    let conversation: any = { shoppingState: "MAIN_MENU", pendingVariantId: null, customerId: "cust1", activeProductId: null, assistedBuyingContext: null };

    const messages = ["I want 2 Premium Cotton T-Shirts", "Actually, make it 5", "No, just 3", "Add another one"];
    for (const m of messages) {
      conversations.sendButtons.mockClear(); conversations.sendList.mockClear(); conversations.sendMessage.mockClear();
      console.log(`\n--- "${m}" ---`);
      await flow.handleFreeText("conv1", "biz1", conversation, m);
      console.log("addItem calls this turn:", cart.addItem.mock.calls.length, "updateItemQuantity calls this turn:", cart.updateItemQuantity.mock.calls.length);
      if (conversations.sendButtons.mock.calls.length) console.log("sendButtons:", conversations.sendButtons.mock.calls.at(-1)[2]);
      if (conversations.sendList.mock.calls.length) console.log("sendList:", conversations.sendList.mock.calls.at(-1)[2]);
      if (conversations.sendMessage.mock.calls.length) console.log("sendMessage:", conversations.sendMessage.mock.calls.at(-1)[2]);
      const lastUpdate = prisma.conversation.update.mock.calls.at(-1);
      console.log("context after:", lastUpdate ? JSON.stringify(lastUpdate[0].data.assistedBuyingContext) : "(no update)");
      conversation = { ...conversation, assistedBuyingContext: lastUpdate ? lastUpdate[0].data.assistedBuyingContext : conversation.assistedBuyingContext };
      cart.addItem.mockClear(); cart.updateItemQuantity.mockClear();
    }

    expect(true).toBe(true);
  });
});
