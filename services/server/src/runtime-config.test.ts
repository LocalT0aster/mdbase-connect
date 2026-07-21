import { describe, expect, it } from "vitest";
import { validateRuntimeConfig } from "./runtime-config.js";

describe("public runtime configuration", () => {
  it("allows explicit loopback development authentication", () => {
    expect(() => validateRuntimeConfig({
      host: "0.0.0.0",
      publicUrl: "http://localhost:8787",
      devAuth: true,
      tailscaleAuth: false
    })).not.toThrow();
  });

  it("refuses development authentication and plaintext on public origins", () => {
    expect(() => validateRuntimeConfig({
      host: "0.0.0.0",
      publicUrl: "https://connect.example",
      devAuth: true,
      tailscaleAuth: false
    })).toThrow(/Development authentication/);
    expect(() => validateRuntimeConfig({
      host: "0.0.0.0",
      publicUrl: "http://connect.example",
      devAuth: false,
      tailscaleAuth: true
    })).toThrow(/HTTPS/);
  });

  it("refuses to start without a real authentication mode", () => {
    expect(() => validateRuntimeConfig({
      host: "127.0.0.1",
      publicUrl: "http://127.0.0.1:8787",
      devAuth: false,
      tailscaleAuth: false
    })).toThrow(/identity provider/);
  });
});
