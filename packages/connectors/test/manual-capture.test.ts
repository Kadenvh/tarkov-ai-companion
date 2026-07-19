import { describe, expect, it } from "vitest";
import {
  createManualCaptureConnector,
  type ManualCapturePayload,
  type ManualCapturePrompt,
} from "../src/connectors/manual-capture.js";

const FIXED = "2026-01-01T00:00:00.000Z";

describe("manual-capture connector", () => {
  it("advertises manual-capture at riskTier T0 and is always installed", async () => {
    const connector = createManualCaptureConnector({ clock: () => FIXED });
    expect(connector.id).toBe("manual-capture");
    expect(connector.capabilities).toEqual(["manual-capture"]);
    expect(connector.riskTier).toBe("T0");
    expect((await connector.detect()).installed).toBe(true);
    expect(await connector.health()).toBe("connected");
  });

  it("returns a prompt descriptor when no payload is supplied", async () => {
    const connector = createManualCaptureConnector({
      targetCapability: "audio-mix",
      clock: () => FIXED,
    });
    const reading = await connector.read("manual-capture");
    expect(reading.connectorId).toBe("manual-capture");
    expect(reading.capturedAt).toBe(FIXED);

    const data = reading.data as ManualCapturePrompt;
    expect(data.kind).toBe("prompt");
    expect(data.accepts).toEqual(["paste", "screenshot"]);
    expect(data.targetCapability).toBe("audio-mix");
    expect(typeof data.message).toBe("string");
  });

  it("wraps a user-supplied payload into a provenance-tagged reading", async () => {
    const payload = { chatMix: 60, eq: "footsteps" };
    const connector = createManualCaptureConnector({
      payload,
      targetCapability: "audio-mix",
      clock: () => FIXED,
    });
    const reading = await connector.read("manual-capture");

    const data = reading.data as ManualCapturePayload<typeof payload>;
    expect(data.kind).toBe("payload");
    expect(data.payload).toEqual(payload);
    expect(data.targetCapability).toBe("audio-mix");
  });

  it("honors a custom prompt message and accepts list", async () => {
    const connector = createManualCaptureConnector({
      message: "Paste your Sonar EQ curve",
      accepts: ["paste"],
      clock: () => FIXED,
    });
    const data = (await connector.read("manual-capture")).data as ManualCapturePrompt;
    expect(data.message).toBe("Paste your Sonar EQ curve");
    expect(data.accepts).toEqual(["paste"]);
    expect(data.targetCapability).toBeUndefined();
  });

  it("read rejects a capability the connector does not advertise", async () => {
    const connector = createManualCaptureConnector();
    await expect(connector.read("game-config")).rejects.toThrow(/cannot read capability/);
  });
});
