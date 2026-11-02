import { describe, expect, it } from "vitest";

import { parseReceiptPages } from "../src/viewer/receipts/receiptParser";
import { receiptPagesFromPlainText } from "../src/viewer/receipts/receiptPlainText";
import type { OcrReceiptPage } from "../src/viewer/receipts/types";

describe("receipt parser", () => {
  it.each([
    {
      name: "Target", text: "TARGET CIRCLE\n10/14/26\nHandbags\n$35.00\nSUBTOTAL\n$35.00\nTAX\n$3.11\nTOTAL\n$38.11",
      merchant: "Target", subtotal: 3_500, tax: 311, total: 3_811, lines: [["Handbags", 3_500]],
    },
    {
      name: "ACME", text: "ACME MARKETS\n10/20/26\nPAPER NAPKINS 9.99\nDRAGON FRUIT 4.50\nSUBTOTAL 14.49\nTAX 1.28\nTOTAL 15.77",
      merchant: "ACME MARKETS", subtotal: 1_449, tax: 128, total: 1_577,
      lines: [["PAPER NAPKINS", 999], ["DRAGON FRUIT", 450]],
    },
    {
      name: "Lowe's", text: "LOWE'S HOME CENTERS, LLC\n11/01/26\nFIBERGLASS HAMMER\n22.98\nSUBTOTAL\n22.98\nTAX\n2.04\nTOTAL\n25.02",
      merchant: "LOWE'S HOME CENTERS, LLC", subtotal: 2_298, tax: 204, total: 2_502,
      lines: [["FIBERGLASS HAMMER", 2_298]],
    },
    {
      name: "Stop & Shop", text: "STOP & SHOP\n11/02/26\nRASPBERRIES\n3.49\nSUBTOTAL\n3.49\nTAX\n0.31\nBALANCE\n3.80",
      merchant: "Stop & Shop", subtotal: 349, tax: 31, total: 380, lines: [["RASPBERRIES", 349]],
    },
    {
      name: "Home Depot", text: "THE HOME DEPOT\n11/02/26\nPROPANE TANK EXCHANGE\n21.94\nSUBTOTAL\n21.94\nTAX\n1.95\nTOTAL\n23.89",
      merchant: "THE HOME DEPOT", subtotal: 2_194, tax: 195, total: 2_389,
      lines: [["PROPANE TANK EXCHANGE", 2_194]],
    },
  ])("parses sanitized Apple Vision text for $name", ({ text, merchant, subtotal, tax, total, lines }) => {
    const result = parseReceiptPages(receiptPagesFromPlainText([{ page_index: 0, text }]));

    expect(result).toMatchObject({ merchant: { value: merchant }, subtotal_minor: { value: subtotal },
      tax_minor: { value: tax }, total_minor: { value: total } });
    expect(result.lines.map((line) => [line.description, line.item_total_minor])).toEqual(lines);
  });

  it("extracts merchant, date, lines, and totals with source confidence", () => {
    const result = parseReceiptPages([page(0, [
      observation("merchant", "SYNTHETIC MARKET", 20, 0.02),
      observation("date", "11/01/2026", 100, 0.08),
      observation("apple", "APPLES 4.50", 300, 0.21),
      observation("bread", "BREAD 3.25", 360, 0.26),
      observation("subtotal", "SUBTOTAL 7.75", 900, 0.70),
      observation("tax", "TAX 0.52", 960, 0.75),
      observation("total", "TOTAL 8.27", 1040, 0.82),
    ])]);
    expect(result).toMatchObject({
      merchant: { value: "SYNTHETIC MARKET" },
      purchase_date: { value: "2026-11-01" },
      subtotal_minor: { value: 775 }, tax_minor: { value: 52 }, total_minor: { value: 827 },
    });
    expect(result.lines.map((line) => [line.description, line.item_total_minor]))
      .toEqual([["APPLES", 450], ["BREAD", 325]]);
    expect(result.lines[0].confidence_basis_points).toBe(9_000);
  });

  it("collapses only exact adjacent boundary overlaps", () => {
    const result = parseReceiptPages([
      page(0, [
        observation("a", "APPLE 4.50", 900, 0.90),
        observation("overlap-1", "SOAP 5.00", 1100, 0.96),
      ]),
      page(1, [
        observation("overlap-2", "SOAP 5.00", 20, 0.02),
        observation("b", "MILK 4.25", 300, 0.25),
      ]),
    ]);
    expect(result.lines.map((line) => line.description)).toEqual(["APPLE", "SOAP", "MILK"]);
    expect(result.collapsed_observation_ids).toEqual(["overlap-2"]);
  });

  it("groups uncertain similar overlaps and preserves legitimate repeated items", () => {
    const uncertain = parseReceiptPages([
      page(0, [observation("left", "COFFEE 8.99", 1100, 0.96)]),
      page(1, [observation("right", "COFEEE 8.99", 20, 0.02)]),
    ]);
    expect(uncertain.lines).toHaveLength(2);
    expect(uncertain.overlap_groups).toEqual([{ id: "overlap-1", observation_ids: ["left", "right"] }]);

    const repeated = parseReceiptPages([page(0, [
      observation("one", "WATER 2.00", 300, 0.2),
      observation("two", "WATER 2.00", 500, 0.4),
    ])]);
    expect(repeated.lines).toHaveLength(2);
    expect(repeated.overlap_groups).toEqual([]);
  });

  it("extracts discounts, tips, and service fees without turning them into products", () => {
    const result = parseReceiptPages([page(0, [
      observation("merchant", "CAFE FIXTURE", 10, 0.01),
      observation("meal", "MEAL 20.00", 100, 0.10),
      observation("drink", "DRINK 5.00", 200, 0.20),
      observation("discount", "DISCOUNT -2.00", 300, 0.30),
      observation("tax", "TAX 1.50", 400, 0.40),
      observation("tip", "TIP 4.00", 500, 0.50),
      observation("fee", "SERVICE FEE 1.00", 600, 0.60),
      observation("total", "TOTAL 29.50", 900, 0.90),
    ])]);
    expect(result).toMatchObject({ discount_minor: { value: 200 }, tax_minor: { value: 150 },
      tip_minor: { value: 400 }, fees_minor: { value: 100 }, total_minor: { value: 2950 } });
    expect(result.lines.map((line) => line.description)).toEqual(["MEAL", "DRINK"]);
  });

  it("keeps exempt grocery markers and missing-subtotal receipts visibly reviewable", () => {
    const result = parseReceiptPages([page(0, [
      observation("merchant", "GROCERY FIXTURE", 10, 0.01),
      observation("milk", "MILK E 4.00", 200, 0.20),
      observation("milk-again", "MILK E 4.00", 300, 0.30),
      observation("total", "TOTAL 8.00", 900, 0.90),
    ])]);
    expect(result.subtotal_minor).toBeUndefined();
    expect(result.lines).toMatchObject([
      { description: "MILK E", item_total_minor: 400 },
      { description: "MILK E", item_total_minor: 400 },
    ]);
    expect(result.overlap_groups).toEqual([]);
  });

  it("prefers a plausible merchant over OCR debris near the top of a photo", () => {
    const result = parseReceiptPages([page(0, [
      observation("debris", "\\ \\", 5, 0.01),
      observation("logo-noise", "a 3 He", 20, 0.03),
      observation("merchant", "LOWE'S HOME CENTERS, LLC", 70, 0.08),
      observation("date", "11/01/26 12:54 PM", 120, 0.13),
      observation("item", "FIBERGLASS HAMMER 22.98", 300, 0.30),
      observation("total", "TOTAL 24.99", 900, 0.90),
    ])]);

    expect(result.merchant?.value).toBe("LOWE'S HOME CENTERS, LLC");
    expect(result.purchase_date?.value).toBe("2026-11-01");
  });

  it("normalizes common OCR punctuation only on labeled receipt totals", () => {
    const result = parseReceiptPages([page(0, [
      observation("merchant", "THE HOME DEPOT", 20, 0.02),
      observation("item", "PROPANE TANK EXCHANGE 21.94", 300, 0.30),
      observation("subtotal", "SUBTOTAL 21.94", 700, 0.70),
      observation("tax", "~ TOTAL TAK: 1.95 noise", 760, 0.76),
      observation("total", "| TOTAL $23, 89 foil ne", 820, 0.82),
    ])]);

    expect(result).toMatchObject({
      merchant: { value: "THE HOME DEPOT" }, subtotal_minor: { value: 2_194 },
      tax_minor: { value: 195 }, total_minor: { value: 2_389 },
    });
    expect(result.lines.map((line) => [line.description, line.item_total_minor]))
      .toEqual([["PROPANE TANK EXCHANGE", 2_194]]);
  });

  it("uses a checkout balance as the total and excludes payment-summary rows", () => {
    const result = parseReceiptPages([page(0, [
      observation("merchant", "STOPEESHOP", 20, 0.02),
      observation("item", "RASPBERRIES 3.49", 240, 0.24),
      observation("tax", "TAX 0.27", 700, 0.70),
      observation("pre-discount", "TOTAL AFTER SAVINGS 61.73", 720, 0.72),
      observation("balance", "with BALANCE 52.0¢", 760, 0.76),
      observation("payment", "MASTERCARD 52.00", 820, 0.82),
      observation("change", "CHANGE 0.00", 880, 0.88),
    ])]);

    expect(result.total_minor?.value).toBe(5_200);
    expect(result.merchant?.value).toBe("STOPEESHOP");
    expect(result.lines.map((line) => [line.description, line.item_total_minor]))
      .toEqual([["RASPBERRIES", 349]]);
  });

  it("pairs descriptions and prices printed in separate receipt columns", () => {
    const result = parseReceiptPages([page(0, [
      observationAt("merchant", "LOWE'S HOME CENTERS, LLC", 200, 40, 700, 50),
      observationAt("date", "TRANS#: 55 11-01-26", 300, 100, 600, 50),
      observationAt("paint", "1G SIGNATURE EGG UV BASE", 200, 250, 900, 50),
      observationAt("paint-price", "46.98", 1_500, 248, 180, 52),
      observationAt("hammer", "FIBERGLASS HAMMER, 18", 200, 340, 900, 50),
      observationAt("hammer-price", "22.98", 1_500, 342, 180, 50),
      observationAt("subtotal", "SUBTOTAL:", 1_000, 700, 300, 50),
      observationAt("subtotal-price", "69.96", 1_500, 702, 180, 50),
      observationAt("total", "TOTAL:", 1_000, 800, 300, 50),
      observationAt("total-price", "76.17", 1_500, 802, 180, 50),
    ])]);

    expect(result.lines.map((line) => [line.description, line.item_total_minor])).toEqual([
      ["1G SIGNATURE EGG UV BASE", 4_698],
      ["FIBERGLASS HAMMER, 18", 2_298],
    ]);
    expect(result).toMatchObject({ subtotal_minor: { value: 6_996 }, total_minor: { value: 7_617 } });
  });

  it("uses price-you-pay as the grocery item amount and excludes savings rows", () => {
    const result = parseReceiptPages([page(0, [
      observationAt("merchant", "STOP8SHOP", 100, 20, 500, 50),
      observationAt("item", "CAB PEPRJCK CUT7", 200, 200, 700, 50),
      observationAt("item-price", "3.99 F", 1_500, 200, 180, 50),
      observationAt("savings", "SAVINGS", 200, 255, 400, 50),
      observationAt("discount", "0.99-F", 1_500, 255, 180, 50),
      observationAt("pay-label", "PRICE YOU PAY", 200, 310, 600, 50),
      observationAt("pay", "3.00", 1_350, 310, 180, 50),
      observationAt("balance", "BALANCE", 900, 800, 300, 50),
      observationAt("balance-price", "3.27", 1_500, 800, 180, 50),
    ])]);

    expect(result.merchant?.value).toBe("Stop & Shop");
    expect(result.lines.map((line) => [line.description, line.item_total_minor]))
      .toEqual([["CAB PEPRJCK CUT7", 300]]);
  });

  it("drops a near-identical full-page photo instead of duplicating every item", () => {
    const first = page(0, [
      observation("merchant-a", "ACME MARKETS", 20, 0.02),
      observation("apple-a", "APPLES 4.50", 300, 0.30),
      observation("bread-a", "BREAD 3.25", 500, 0.50),
      observation("total-a", "TOTAL 7.75", 900, 0.90),
    ]);
    const second = page(1, [
      observation("merchant-b", "ACME MARKETS", 25, 0.02),
      observation("apple-b", "APPLES 4.50", 305, 0.30),
      observation("bread-b", "BREAD 3.25", 505, 0.50),
      observation("total-b", "TOTAL 7.75", 905, 0.90),
    ]);

    const result = parseReceiptPages([first, second]);

    expect(result.lines.map((line) => line.description)).toEqual(["APPLES", "BREAD"]);
    expect(result.duplicate_page_indexes).toEqual([1]);
  });

  it("normalizes recognizable merchant evidence without using a remote lookup", () => {
    const cases = [
      [["TARGET CIRCLE", "Handbags 35.00"], "Target"],
      [["STOP8SHOP", "BALANCE 52.00"], "Stop & Shop"],
      [["How doers get more done.", "DEPOT", "TANK EXCHANGE 21.94"], "The Home Depot"],
      [["Liquor Wine arehus out Bkn", "3090 Ocean Ave."], "Liquor Wine Warehouse South Brooklyn"],
      [["Favorite Local", "SIG CUTLERY FULL 9.99", "M/B CINN STICKS 10.49"], "ACME Markets"],
    ] as const;
    for (const [texts, expected] of cases) {
      const result = parseReceiptPages([page(0, texts.map((text, index) =>
        observation(`line-${index}`, text, 20 + index * 100, 0.02 + index * 0.1))) ]);
      expect(result.merchant?.value).toBe(expected);
    }
  });

  it("keeps adjacent Target item, subtotal, tax, and total rows separate on a skewed photo", () => {
    const result = parseReceiptPages([page(0, [
      observationAt("date", "10/14/206 05:47", 698, 1_006, 365, 84),
      observationAt("item-price", "$35.00", 1_202, 1_291, 171, 71),
      observationAt("department", "APPAREL", 442, 1_304, 160, 61),
      observationAt("tax-marker", "T", 1_057, 1_328, 29, 46),
      observationAt("item", "024002664 Handbags", 444, 1_346, 414, 62),
      observationAt("subtotal-price", "$35.00", 1_198, 1_393, 176, 68),
      observationAt("subtotal", "SUBTOTAL", 938, 1_411, 171, 75),
      observationAt("tax-price", "$3.11", 1_220, 1_447, 153, 64),
      observationAt("tax", "T = NY TAX 8.87500 on $35.00", 499, 1_456, 625, 97),
      observationAt("total-price", "$38.11", 1_198, 1_492, 178, 67),
      observationAt("total", "TOTAL", 996, 1_508, 123, 68),
      observationAt("merchant", "TARGET CIRCLE", 724, 2_151, 293, 73),
    ])]);

    expect(result).toMatchObject({ purchase_date: { value: "2026-10-14" },
      subtotal_minor: { value: 3_500 }, tax_minor: { value: 311 }, total_minor: { value: 3_811 } });
    expect(result.lines.map((line) => [line.description, line.item_total_minor]))
      .toEqual([["Handbags", 3_500]]);
  });

  it("pairs an offset summary column in order instead of assigning tax to balance", () => {
    const result = parseReceiptPages([page(0, [
      observationAt("last-item", "BELL PEPPER 5.99", 500, 2_280, 700, 70),
      observationAt("tax", "TAX", 640, 2_330, 90, 64),
      observationAt("balance", "BALANCE", 638, 2_384, 180, 66),
      observationAt("tax-price", "1.91", 1_216, 2_397, 113, 84),
      observationAt("balance-price", "109.61", 1_191, 2_434, 155, 118),
    ])]);

    expect(result.tax_minor?.value).toBe(191);
    expect(result.total_minor?.value).toBe(10_961);
    expect(result.subtotal_minor?.value).toBe(10_770);
  });

  it("reconstructs an ACME multi-column receipt from item, regular-price, savings, and final-price columns", () => {
    const result = parseReceiptPages([page(0, [
      observationAt("merchant", "Favorite Local", 590, 176, 400, 50),
      observationAt("item-1", "M/B CIN STIOKS", 590, 855, 360, 50),
      observationAt("regular-1", "13.99", 1_003, 774, 140, 50),
      observationAt("saving-1", "Sale Savirs", 591, 909, 200, 50),
      observationAt("discount-1", "-3.50", 799, 909, 120, 50),
      observationAt("item-2", "SIG CUTLERY FULL", 591, 996, 360, 50),
      observationAt("regular-2", "d.99", 1_010, 980, 140, 50),
      observationAt("item-3", "CHINET SUT CRYSTAL", 601, 1_053, 360, 50),
      observationAt("final-3", "9.49", 1_129, 1_051, 140, 50),
      observationAt("item-4", "CHINET CUT CRYSTAL", 595, 1_147, 360, 50),
      observationAt("item-5", "SOLO PAPERPLATE D", 596, 1_234, 360, 50),
      observationAt("final-5", "3.99", 1_134, 1_166, 140, 50),
      observationAt("item-6", "OPN NAT NAPKINS", 600, 1_339, 360, 50),
      observationAt("final-6", "4.49", 1_140, 1_280, 140, 50),
      observationAt("tax", "TAX", 642, 2_330, 100, 50),
      observationAt("tax-value", "1.91", 1_216, 2_397, 120, 50),
      observationAt("balance", "BALANCE", 638, 2_384, 200, 50),
      observationAt("total", "49.85", 1_191, 2_434, 150, 50),
    ])]);

    expect(result.lines.map((line) => [line.description, line.item_total_minor])).toEqual([
      ["M/B CINNAMON STICKS", 1_049], ["SIG CUTLERY FULL", 999],
      ["CHINET CUT CRYSTAL", 949], ["CHINET CUT CRYSTAL", 949],
      ["SOLO PAPER PLATES", 399], ["OPEN NATURE NAPKINS", 449],
    ]);
  });

  it("uses sale prices after OCR-misspelled Stop & Shop savings labels", () => {
    const result = parseReceiptPages([page(0, [
      observationAt("merchant", "STOP&SHOP", 500, 20, 400, 50),
      observationAt("item", "CAB PEFRJCK CUT7", 640, 200, 500, 50),
      observationAt("item-price", "3.95 F", 1_100, 200, 180, 50),
      observationAt("savings", "SRVINGS", 640, 250, 300, 50),
      observationAt("discount", "0.99-F", 1_100, 250, 180, 50),
      observationAt("pay-label", "PRICE E YOU PFY", 540, 300, 500, 50),
      observationAt("pay", "3.00", 1_000, 300, 180, 50),
      observationAt("balance", "BALLANCE", 650, 800, 300, 50),
      observationAt("balance-price", "3.27", 1_100, 800, 180, 50),
    ])]);

    expect(result.lines.map((line) => [line.description, line.item_total_minor]))
      .toEqual([["CABOT PEPPER JACK CUT 7 OZ", 300]]);
  });

  it("reconstructs four liquor items and ignores promotion metadata", () => {
    const result = parseReceiptPages([page(0, [
      observationAt("merchant", "Liquor Wine Karehouse Sout Brookyn", 570, 100, 600, 50),
      observationAt("first", "7414 UNT LENFI SINGLE MALT 1 TML", 480, 300, 550, 50),
      observationAt("first-price", "$62.99", 900, 350, 180, 50),
      observationAt("second", "8413 TKYLSRENEC", 480, 400, 300, 50),
      observationAt("second-price", "$69.99", 900, 450, 180, 50),
      observationAt("rashi-1", "09484 UNIT RASHI I CLARET 750ML", 480, 500, 600, 50),
      observationAt("rashi-price-1", "$8.00 2 FOR $15.99", 900, 510, 300, 50),
      observationAt("rashi-2", "09484 UNIT RASHI CLARET 750ML", 480, 600, 600, 50),
      observationAt("rashi-price-2", "$8.00 2 FOR $15.99", 900, 610, 300, 50),
      observationAt("items", "# Items", 470, 700, 200, 50),
      observationAt("item-count", "4", 1_130, 700, 50, 50),
      observationAt("subtotal", "Subtotal", 470, 750, 250, 50),
      observationAt("subtotal-price", "$148.98", 950, 750, 180, 50),
      observationAt("tax", "Sales Tax", 470, 800, 250, 50),
      observationAt("tax-price", "$13.22", 950, 800, 180, 50),
      observationAt("total", "Total Sale", 470, 850, 250, 50),
      observationAt("total-price", "$162.20", 950, 850, 180, 50),
    ])]);

    expect(result.lines.map((line) => [line.description, line.item_total_minor])).toEqual([
      ["GLENFIDDICH 14 YEAR SINGLE MALT 750 ML", 6_299],
      ["MILK & HONEY ELEMENTS RED WINE 750 ML", 6_999],
      ["RASHI CLARET 750 ML", 800], ["RASHI CLARET 750 ML", 800],
    ]);
  });

  it("recognizes Home Depot from its unique slogan when the logo is outside the photo", () => {
    const result = parseReceiptPages([page(0, [
      observationAt("slogan", "get more done.", 700, 100, 400, 50),
      observationAt("priced-item", "0000-503-194 TANK EXCHNGEA>", 500, 300, 600, 50),
      observationAt("item-detail", "PARACO EMPTY PROPANE TANK EXCHANGE", 560, 350, 700, 50),
      observationAt("price", "21.94", 1_170, 300, 180, 50),
      observationAt("total", "TOTAL", 850, 800, 200, 50),
      observationAt("total-price", "$23.89", 1_170, 800, 180, 50),
    ])]);

    expect(result.merchant?.value).toBe("The Home Depot");
    expect(result.lines.map((line) => [line.description, line.item_total_minor]))
      .toEqual([["PARACO EMPTY PROPANE TANK EXCHANGE", 2_194]]);
  });

  it("extracts only purchases from a Lowe's checkout screen", () => {
    const result = parseReceiptPages([page(0, [
      observationAt("logo", "OWE'S", 400, 500, 300, 50),
      observationAt("mode", "Mainline Self_Checkout", 1_100, 1_000, 500, 50),
      observationAt("count", "3 Items", 0, 1_100, 200, 50),
      observationAt("hammer", "Smooth Face Fiberglass Hammer, 18-Ounce", 220, 1_300, 900, 50),
      observationAt("hammer-old", "$26.98", 1_050, 1_300, 150, 50),
      observationAt("hammer-price", "$22.98", 1_500, 1_300, 150, 50),
      observationAt("ad", "Save $4.00/ea", 1_050, 1_350, 300, 50),
      observationAt("candy", "3 oz Milk Chocolate Candy Bar", 220, 1_500, 800, 50),
      observationAt("candy-price", "$4.28", 1_500, 1_500, 150, 50),
      observationAt("paint", "Signature Eggshell Ultra White Tintable Interior", 220, 1_700, 900, 50),
      observationAt("paint-detail", "Paint Paint + Primer ( 1-gallon)", 220, 1_750, 900, 50),
      observationAt("paint-price", "$46.98", 1_500, 1_700, 150, 50),
      observationAt("fee", "NY PAINTCARE RECOVERY FEE", 400, 1_900, 700, 50),
      observationAt("fee-price", "$0.95", 1_500, 1_900, 150, 50),
      observationAt("subtotal", "Subtotal", 1_600, 2_300, 220, 50),
      observationAt("subtotal-price", "$75.19", 1_500, 2_340, 180, 50),
    ])]);

    expect(result.merchant?.value).toBe("LOWE'S");
    expect(result.subtotal_minor?.value).toBe(7_519);
    expect(result.lines.map((line) => [line.description, line.item_total_minor])).toEqual([
      ["SMOOTH FACE FIBERGLASS HAMMER, 18 OZ", 2_298],
      ["KIT KAT MILK CHOCOLATE CANDY BAR, 3 OZ", 428],
      ["SIGNATURE EGGSHELL ULTRA WHITE INTERIOR PAINT + PRIMER, 1 GAL", 4_698],
      ["NY PAINTCARE RECOVERY FEE", 95],
    ]);
  });

  it("corrects ambiguous 5/9 price digits only when the printed subtotal proves the correction", () => {
    const result = parseReceiptPages([page(0, [
      observationAt("merchant", "STOP&SHOP", 500, 20, 400, 50),
      observationAt("one", "CHBN CRMR SWC24Z", 500, 200, 500, 50),
      observationAt("one-price", "5.95 F", 1_100, 200, 180, 50),
      observationAt("two", "SBK BRU SG CNN", 500, 300, 500, 50),
      observationAt("two-price", "6.45 F", 1_100, 300, 180, 50),
      observationAt("three", "LNGR MNG MANG64Z", 500, 400, 500, 50),
      observationAt("three-price", "2.95 B", 1_100, 400, 180, 50),
      observationAt("subtotal", "Total Aifter Savinss", 500, 700, 500, 50),
      observationAt("subtotal-price", "15.47", 1_100, 700, 180, 50),
      observationAt("tax", "TAX", 500, 750, 200, 50),
      observationAt("tax-price", "0.00", 1_100, 750, 180, 50),
      observationAt("balance", "BALLANCE", 500, 800, 300, 50),
      observationAt("balance-price", "15.47", 1_100, 800, 180, 50),
    ])]);

    expect(result.lines.map((line) => line.item_total_minor)).toEqual([599, 649, 299]);
    expect(result.lines.every((line) => line.review_flags.includes("ocr_digit_reconciled"))).toBe(true);
  });
});

function observation(id: string, text: string, y: number, relativeY: number) {
  return { id, text, confidence_basis_points: 9_000,
    bbox: { x: 10, y, width: 500, height: 40 }, relative_y: relativeY };
}

function observationAt(id: string, text: string, x: number, y: number, width: number, height: number) {
  return { id, text, confidence_basis_points: 9_000,
    bbox: { x, y, width, height }, relative_y: y / 1_000 };
}

function page(index: number, observations: ReturnType<typeof observation>[]): OcrReceiptPage {
  return { id: `page-${index}`, page_index: index, text: observations.map((item) => item.text).join("\n"),
    confidence_basis_points: 9_000, observations };
}
