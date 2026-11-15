import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import Icon, { generateImageMetadata } from "@/app/icon";
import AppleIcon from "@/app/apple-icon";
import { APP_FULL_NAME, APP_NAME } from "@/lib/brand";
import { config as proxyConfig } from "@/proxy";

describe("Kestrel branding and browser tab icons", () => {
  it("uses Kestrel branding across manifest and constants", () => {
    const webManifest = manifest();
    expect(APP_NAME).toBe("Kestrel");
    expect(webManifest.name).toBe(APP_FULL_NAME);
    expect(webManifest.short_name).toBe("Kestrel");
  });

  it("provides static SVG, multi-size favicon.ico, PWA icon PNGs, and Apple icon", async () => {
    const rootDir = path.join(import.meta.dirname, "..", "..");

    const svgText = fs.readFileSync(path.join(rootDir, "app", "icon.svg"), "utf8");
    expect(svgText).toContain("<svg");
    expect(svgText).toContain("#5B8DEF");
    expect(svgText).toContain("#22C55E");

    const icoBytes = fs.readFileSync(path.join(rootDir, "app", "favicon.ico"));
    expect(icoBytes.readUInt16LE(0)).toBe(0);
    expect(icoBytes.readUInt16LE(2)).toBe(1);
    expect(icoBytes.readUInt16LE(4)).toBe(2); // 16x16 + 32x32 frames

    const meta = generateImageMetadata();
    expect(meta.map((entry) => entry.id)).toEqual(["192", "512"]);

    const icon192 = await Icon({ id: Promise.resolve("192") });
    const icon192Bytes = Buffer.from(await icon192.arrayBuffer());
    expect(icon192Bytes.subarray(0, 4).toString("hex")).toBe("89504e47"); // PNG magic bytes

    const appleRes = AppleIcon();
    const appleBytes = Buffer.from(await appleRes.arrayBuffer());
    expect(appleBytes.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("does not intercept browser tab icons or PWA metadata routes in proxy matcher", () => {
    const matcherPattern = proxyConfig.matcher[0];
    expect(matcherPattern).toBeDefined();
    const regex = new RegExp(`^${matcherPattern}$`);

    expect(regex.test("/favicon.ico")).toBe(false);
    expect(regex.test("/icon.svg")).toBe(false);
    expect(regex.test("/icon")).toBe(false);
    expect(regex.test("/icon/192")).toBe(false);
    expect(regex.test("/icon/512")).toBe(false);
    expect(regex.test("/apple-icon")).toBe(false);
    expect(regex.test("/manifest.webmanifest")).toBe(false);
    expect(regex.test("/icons/icon.svg")).toBe(false);

    expect(regex.test("/dashboard")).toBe(true);
    expect(regex.test("/api/analytics")).toBe(true);
  });
});

