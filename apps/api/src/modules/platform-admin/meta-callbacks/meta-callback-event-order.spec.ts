import { orderCallbackEvents } from "./meta-callback-event-order";

const T0 = new Date("2026-10-26T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const event = (id: string, action: string, createdAt = T0) => ({ id, action, createdAt });
const actions = (events: { action: string }[]) => events.map((e) => e.action);
const permutations = <T>(items: T[]): T[][] => (items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])));

describe("orderCallbackEvents", () => {
  // the ids sort the opposite way to the lifecycle, so an id-based order would be exactly wrong
  const received = event("evt-z-received", "RECEIVED");
  const processed = event("evt-m-processed", "PROCESSED");
  const resolved = event("evt-a-resolved", "RESOLVED");

  it("orders events with identical timestamps by lifecycle stage, not by id", () => {
    expect(actions(orderCallbackEvents([resolved, processed, received]))).toEqual(["RECEIVED", "PROCESSED", "RESOLVED"]);
    expect([resolved, processed, received].map((e) => e.id).sort()).toEqual(["evt-a-resolved", "evt-m-processed", "evt-z-received"]); // id order would put RESOLVED first
  });

  it.each(permutations([received, processed, resolved]).map((p) => [actions(p).join(" > "), p] as const))("returns the same order whatever order the database returned them in (%s)", (_label, input) => {
    expect(actions(orderCallbackEvents(input))).toEqual(["RECEIVED", "PROCESSED", "RESOLVED"]);
  });

  it("resolves a tie only between events that share a timestamp: an earlier timestamp always comes first", () => {
    const early = event("evt-z-1", "PROCESSED", at(0));
    const lateReceived = event("evt-a-2", "RECEIVED", at(5));
    const lateProcessed = event("evt-a-3", "PROCESSED", at(5));
    expect(orderCallbackEvents([lateProcessed, lateReceived, early]).map((e) => e.id)).toEqual(["evt-z-1", "evt-a-2", "evt-a-3"]);
  });

  it("keeps the recorded order when timestamps differ, even if it contradicts the lifecycle (no clock-skew correction is claimed)", () => {
    expect(actions(orderCallbackEvents([event("evt-1", "RESOLVED", at(0)), event("evt-2", "PROCESSED", at(1))]))).toEqual(["RESOLVED", "PROCESSED"]);
  });

  it("places an action it does not know after the known ones at the same timestamp, then by id", () => {
    const events = [event("evt-b", "NOTE"), event("evt-a", "NOTE"), resolved, received];
    expect(orderCallbackEvents(events).map((e) => e.id)).toEqual(["evt-z-received", "evt-a-resolved", "evt-a", "evt-b"]);
  });

  it("breaks a tie between the same action and timestamp by id, repeatably, and says nothing about which came first", () => {
    const first = orderCallbackEvents([event("evt-2", "RESOLVED"), event("evt-1", "RESOLVED")]);
    const second = orderCallbackEvents([event("evt-1", "RESOLVED"), event("evt-2", "RESOLVED")]);
    expect(first.map((e) => e.id)).toEqual(["evt-1", "evt-2"]);
    expect(second).toEqual(first);
  });

  it("returns a new array and leaves its input untouched", () => {
    const input = [resolved, received];
    const output = orderCallbackEvents(input);
    expect(output).not.toBe(input);
    expect(input.map((e) => e.action)).toEqual(["RESOLVED", "RECEIVED"]);
  });

  it("keeps every field of each event", () => {
    const rich = { ...resolved, actorUserId: "admin-1", detail: { outcome: "NO_CHANGE" }, fromStatus: "NO_ACTION_UNVERIFIED", toStatus: "NO_CHANGE_RECORDED" };
    expect(orderCallbackEvents([rich, received])[1]).toBe(rich);
  });
});
