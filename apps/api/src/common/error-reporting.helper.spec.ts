import * as Sentry from "@sentry/node";
import { captureException, initErrorReporting, isErrorReportingConfigured } from "./error-reporting.helper";

describe("error-reporting.helper", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
  });

  it("is not configured and never calls Sentry when SENTRY_DSN is unset", () => {
    delete process.env.SENTRY_DSN;
    const spy = jest.spyOn(Sentry, "captureException");
    expect(isErrorReportingConfigured()).toBe(false);
    captureException(new Error("boom"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not initialize Sentry when SENTRY_DSN is unset", () => {
    delete process.env.SENTRY_DSN;
    const spy = jest.spyOn(Sentry, "init");
    initErrorReporting();
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports the exception (with extra context) once SENTRY_DSN is set", () => {
    process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/0";
    const spy = jest.spyOn(Sentry, "captureException").mockReturnValue("event-id");
    const error = new Error("boom");
    captureException(error, { orderId: "order1" });
    expect(spy).toHaveBeenCalledWith(error, { extra: { orderId: "order1" } });
  });
});
