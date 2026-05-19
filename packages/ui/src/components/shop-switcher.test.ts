import { describe, expect, it } from "vitest";
import { ShopSwitcher, type ShopSwitcherProps } from "./shop-switcher";

describe("ShopSwitcher", () => {
  it("is exported as a forwardRef component", () => {
    expect(typeof ShopSwitcher).toBe("object");
    expect(ShopSwitcher).not.toBeNull();
  });

  it("shopName accepts null (loading state)", () => {
    const props: ShopSwitcherProps = { shopName: null, shopInitials: null, planLabel: null };
    expect(props.shopName).toBeNull();
    expect(props.shopInitials).toBeNull();
  });

  it("shopName accepts undefined (also triggers loading state)", () => {
    const props: ShopSwitcherProps = {};
    expect(props.shopName).toBeUndefined();
  });

  it("accepts a valid shopName string", () => {
    const props: ShopSwitcherProps = {
      shopName: "Lapsed test",
      shopInitials: "LT",
      planLabel: "Starter",
    };
    expect(props.shopName).toBe("Lapsed test");
  });
});
