import { ConversationService } from "./conversation.service";
import type { PrismaService } from "../../database/prisma.service";

describe("ConversationService", () => {
  let prisma: any;
  let conversations: ConversationService;

  beforeEach(() => {
    prisma = {
      conversation: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    conversations = new ConversationService(prisma as unknown as PrismaService);
  });

  describe("listForCustomer", () => {
    it("includes the customer relation — the Customer 360 profile's Overview tab renders it directly and crashes without it", async () => {
      await conversations.listForCustomer("cust1", "biz1", 1, 20);
      const [args] = prisma.conversation.findMany.mock.calls[0];
      expect(args.include.customer).toBeDefined();
      expect(args.include.customer.select).toMatchObject({ id: true, firstName: true, lastName: true, phone: true });
    });

    it("scopes the query to the given business and customer", async () => {
      await conversations.listForCustomer("cust1", "biz1", 1, 20);
      const [args] = prisma.conversation.findMany.mock.calls[0];
      expect(args.where).toEqual({ businessId: "biz1", customerId: "cust1" });
    });

    it("paginates via skip/take from page/pageSize", async () => {
      await conversations.listForCustomer("cust1", "biz1", 3, 10);
      const [args] = prisma.conversation.findMany.mock.calls[0];
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
    });
  });
});
