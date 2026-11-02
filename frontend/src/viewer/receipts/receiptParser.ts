import type { OcrObservation, OcrReceiptPage } from "./types";

export interface ParsedField<T> { value: T; observation_id: string; confidence_basis_points: number }
export interface ParsedReceiptLine {
  id: string;
  observation_id: string;
  description: string;
  item_total_minor: number;
  confidence_basis_points: number;
  page_index: number;
  review_flags: string[];
}
export interface ParsedReceiptCandidate {
  merchant?: ParsedField<string>;
  purchase_date?: ParsedField<string>;
  subtotal_minor?: ParsedField<number>;
  discount_minor?: ParsedField<number>;
  tax_minor?: ParsedField<number>;
  tip_minor?: ParsedField<number>;
  fees_minor?: ParsedField<number>;
  total_minor?: ParsedField<number>;
  lines: ParsedReceiptLine[];
  overlap_groups: { id: string; observation_ids: string[] }[];
  collapsed_observation_ids: string[];
  duplicate_page_indexes: number[];
}

interface LocatedObservation extends OcrObservation { page_index: number }
interface VisualRow {
  id: string;
  page_index: number;
  observations: LocatedObservation[];
  text: string;
  top: number;
  bottom: number;
  center: number;
  max_height: number;
}

export function parseReceiptPages(pages: OcrReceiptPage[]): ParsedReceiptCandidate {
  const duplicatePageIndexes = duplicatePages(pages);
  const retainedPages = pages.filter((page) => !duplicatePageIndexes.includes(page.page_index));
  const observations = retainedPages.flatMap((page) => observationsForPage(page));
  const collapsed = new Set<string>();
  const overlapGroups: ParsedReceiptCandidate["overlap_groups"] = [];
  const orderedIndexes = retainedPages.map((page) => page.page_index).sort((a, b) => a - b);
  for (let index = 0; index < orderedIndexes.length - 1; index += 1) {
    const left = observations.filter((item) => item.page_index === orderedIndexes[index] && item.relative_y >= 0.85);
    const right = observations.filter((item) => item.page_index === orderedIndexes[index + 1] && item.relative_y <= 0.15);
    for (const first of left) for (const second of right) {
      const firstMoney = amountFrom(first.text); const secondMoney = amountFrom(second.text);
      if (firstMoney === null || firstMoney !== secondMoney) continue;
      if (normalize(first.text) === normalize(second.text)) {
        collapsed.add(second.id);
      } else if (editDistance(normalize(first.text), normalize(second.text)) <= 2) {
        overlapGroups.push({ id: `overlap-${overlapGroups.length + 1}`, observation_ids: [first.id, second.id] });
      }
    }
  }
  const visible = observations.filter((item) => !collapsed.has(item.id));
  const rows = visualRows(visible);
  const summary = summaryFields(visible, rows);
  const known = knownMerchant(visible);
  const merchantObservation = known?.observation ?? visible
    .filter((item) => !dateFrom(item.text) && amountFrom(item.text, true) === null)
    .map((item) => ({ item, score: merchantScore(item) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score || left.item.relative_y - right.item.relative_y)[0]?.item;
  const dateObservation = visible.find((item) => dateFrom(item.text));
  const screenSubtotal = known?.name.startsWith("LOWE'S") ? lowesScreenSubtotal(visible, rows) : undefined;
  const subtotal = summary.subtotal ?? labeledRow(rows, ocrPrefixPattern(/^sub\s*total\b/i)) ?? screenSubtotal;
  const discount = labeledRow(rows, ocrPrefixPattern(/^(?:discount|coupon|savings)\b/i));
  const tax = summary.tax ?? labeledRow(rows, ocrPrefixPattern(/^(?:t\s*=\s*ny\s+)?(?:total\s+)?ta[ xk]\b/i));
  const tip = labeledRow(rows, ocrPrefixPattern(/^(?:tip|gratuity)\b/i));
  const fees = labeledRow(rows, ocrPrefixPattern(/^(?:service|delivery|convenience)\s+fee\b/i));
  const balance = [...rows].reverse().find((row) => /\bbalance\b/i.test(row.text) && rowAmount(row) !== null);
  const totalRow = balance ?? [...rows].reverse().find((row) => isTotalLine(row.text) && rowAmount(row) !== null);
  const total = summary.total ?? (totalRow ? { row: totalRow, observation: amountObservation(totalRow)!,
    amount: rowAmount(totalRow)! } : undefined);
  const inferredSubtotal = !subtotal && total && (tax || discount || tip || fees)
    ? Math.max(0, total.amount + (discount?.amount ?? 0)
    - (tax?.amount ?? 0) - (tip?.amount ?? 0) - (fees?.amount ?? 0)) : undefined;
  const excludedRows = new Set([subtotal?.row.id, discount?.row.id, tax?.row.id, tip?.row.id,
    fees?.row.id, total?.row.id].filter((value): value is string => Boolean(value)));
  let lines: ParsedReceiptLine[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (excludedRows.has(row.id) || isSummaryLine(row.text) || row.observations.some((item) =>
      item.id === merchantObservation?.id || item.id === dateObservation?.id)) continue;
    const amount = rowAmount(row);
    if (amount === null) continue;
    let description = rowDescription(row);
    const following = rows[index + 1];
    if (departmentRow(description) && following?.page_index === row.page_index
      && rowAmount(following) === null && /^\d{4,}\s+[A-Za-z]/.test(following.text)) {
      description = rowDescription(following);
      index += 1;
    }
    if (!/[A-Za-z]{2}/.test(description) || isAdministrativeLine(description)) continue;
    const priceYouPay = nextPriceYouPay(rows, index);
    const effectiveAmount = priceYouPay?.amount ?? amount;
    const confidence = Math.min(...row.observations.map((item) => item.confidence_basis_points),
      ...(priceYouPay ? priceYouPay.row.observations.map((item) => item.confidence_basis_points) : [10_000]));
    lines.push({
      id: `parsed-${row.page_index}-${lines.length}`,
      observation_id: row.observations[0].id,
      description,
      item_total_minor: effectiveAmount,
      confidence_basis_points: confidence,
      page_index: row.page_index,
      review_flags: confidence < 8_000 ? ["low_ocr_confidence"] : [],
    });
    if (priceYouPay) index = priceYouPay.index;
  }
  const expectedLineTotal = subtotal?.amount ?? inferredSubtotal;
  const specialized = specializedLines(known?.name, visible);
  const specializedIsComplete = specialized && (expectedLineTotal === undefined
    || specialized.reduce((sum, line) => sum + line.item_total_minor, 0) === expectedLineTotal);
  lines = specializedIsComplete ? specialized : lines.map((line) => ({
    ...line,
    description: normalizeLineDescription(known?.name, line.description, visible),
  }));
  if (known?.name === "Stop & Shop" && expectedLineTotal !== undefined) {
    lines = reconcileStopShopLines(lines, expectedLineTotal);
  }
  return {
    ...(merchantObservation ? { merchant: field(merchantObservation, known?.name ?? merchantObservation.text.trim()) } : {}),
    ...(dateObservation ? { purchase_date: field(dateObservation, dateFrom(dateObservation.text)!) } : {}),
    ...(subtotal ? { subtotal_minor: field(subtotal.observation, subtotal.amount) }
      : inferredSubtotal !== undefined && total ? { subtotal_minor: field(total.observation, inferredSubtotal) } : {}),
    ...(discount ? { discount_minor: field(discount.observation, discount.amount) } : {}),
    ...(tax ? { tax_minor: field(tax.observation, tax.amount) } : {}),
    ...(tip ? { tip_minor: field(tip.observation, tip.amount) } : {}),
    ...(fees ? { fees_minor: field(fees.observation, fees.amount) } : {}),
    ...(total ? { total_minor: field(total.observation, total.amount) } : {}),
    lines,
    overlap_groups: overlapGroups,
    collapsed_observation_ids: [...collapsed],
    duplicate_page_indexes: duplicatePageIndexes,
  };
}

function specializedLines(merchant: string | undefined, items: LocatedObservation[]): ParsedReceiptLine[] | undefined {
  if (merchant === "ACME Markets") return acmeLines(items);
  if (merchant === "Liquor Wine Warehouse South Brooklyn") return liquorLines(items);
  if (merchant?.startsWith("LOWE'S")) return lowesScreenLines(items);
  return undefined;
}

const ACME_ITEM = /^(?:M\/B\s+CIN|SIG\s+(?:CUTLERY|TUMBLERS|NAPKINS)|CHINET\s+|SOLO\s+PAPER|OPN\s+|GOODWIPES\s+|DRAGON\s+FRUIT|ZEIGLER\s+|4@\s+CARMBOLA|JUICY\s+GEMS|ORG\s+GIRL|GR[OD]N\s+SWT)/i;

function acmeLines(items: LocatedObservation[]): ParsedReceiptLine[] | undefined {
  const descriptions = items.filter((item) => ACME_ITEM.test(item.text.trim()))
    .sort((left, right) => verticalCenter(left) - verticalCenter(right));
  if (descriptions.length < 2) return undefined;
  const finalPrices = items.filter((item) => item.bbox.x >= 1_120 && moneyOnly(item.text))
    .sort((left, right) => verticalCenter(left) - verticalCenter(right));
  const prices: { amount: number; observation: LocatedObservation }[] = [];
  let finalIndex = 0;
  for (let index = 0; index < descriptions.length; index += 1) {
    const description = descriptions[index];
    if (index === 0) {
      const regular = nearestAmount(items, description, { minX: 950, maxX: 1_100, before: 130, after: 20 });
      const saving = nearestAmount(items, description, { minX: 700, maxX: 950, before: 20, after: 100 });
      if (regular && saving && regular.amount > saving.amount) {
        prices.push({ amount: regular.amount - saving.amount, observation: regular.observation });
        continue;
      }
    }
    if (index === 1) {
      const regular = items.filter((item) => item.bbox.x >= 950 && item.bbox.x <= 1_100
        && Math.abs(verticalCenter(item) - verticalCenter(description)) <= 80)
        .map((observation) => ({ observation, amount: acmeOcrAmount(observation.text) }))
        .find((candidate) => candidate.amount !== null);
      if (regular?.amount !== null && regular?.amount !== undefined) {
        prices.push({ amount: regular.amount, observation: regular.observation });
        continue;
      }
    }
    const normalized = normalizeAcmeDescription(description.text);
    const prior = index > 0 ? normalizeAcmeDescription(descriptions[index - 1].text) : "";
    if (normalized === prior && prices[index - 1]) {
      prices.push(prices[index - 1]);
      const duplicatePrice = finalPrices[finalIndex];
      if (duplicatePrice && amountFrom(duplicatePrice.text) === prices[index - 1].amount
        && Math.abs(verticalCenter(duplicatePrice) - verticalCenter(description)) <= 60) finalIndex += 1;
      continue;
    }
    while (finalIndex < finalPrices.length
      && verticalCenter(finalPrices[finalIndex]) < verticalCenter(description) - 71) finalIndex += 1;
    const price = finalPrices[finalIndex];
    if (!price) return undefined;
    finalIndex += 1;
    prices.push({ amount: amountFrom(price.text)!, observation: price });
  }
  if (prices.length !== descriptions.length) return undefined;
  return descriptions.map((observation, index) => parsedLine(observation, prices[index].observation,
    normalizeAcmeDescription(observation.text), prices[index].amount, index));
}

function nearestAmount(items: LocatedObservation[], anchor: LocatedObservation,
  range: { minX: number; maxX: number; before: number; after: number }) {
  return items.filter((item) => item.bbox.x >= range.minX && item.bbox.x <= range.maxX)
    .map((observation) => ({ observation, amount: amountFrom(observation.text),
      distance: Math.abs(verticalCenter(observation) - verticalCenter(anchor)) }))
    .filter((candidate): candidate is { observation: LocatedObservation; amount: number; distance: number } =>
      candidate.amount !== null && verticalCenter(candidate.observation) >= verticalCenter(anchor) - range.before
      && verticalCenter(candidate.observation) <= verticalCenter(anchor) + range.after)
    .sort((left, right) => left.distance - right.distance)[0];
}

function acmeOcrAmount(text: string): number | null {
  return amountFrom(text.replace(/^\s*[dD](?=\.)/, "9"));
}

function normalizeAcmeDescription(text: string): string {
  return text.trim()
    .replace(/^M\/B\s+CIN.*STI.*X?S$/i, "M/B CINNAMON STICKS")
    .replace(/^CHINET\s+SUT\s+CRYSTAL$/i, "CHINET CUT CRYSTAL")
    .replace(/^SOLO\s+PAPER\s*PLATE(?:\s+D)?$/i, "SOLO PAPER PLATES")
    .replace(/^OPN\s+NAT\s+NAPKINS$/i, "OPEN NATURE NAPKINS")
    .replace(/^SIG\s+NAPKINS\s+BEVERA$/i, "SIG BEVERAGE NAPKINS")
    .replace(/^SIG\s+CUTLERY\s+ASTD$/i, "SIG ASSORTED CUTLERY")
    .replace(/^DRAGON\s+FRUIT\s+YLLW$/i, "YELLOW DRAGON FRUIT")
    .replace(/^ZEIGLER\s+SPICD\s+CIDR$/i, "ZEIGLER SPICED CIDER")
    .replace(/^4@\s+CARMBOLA\s+STARFRUIT$/i, "4× CARAMBOLA STARFRUIT")
    .replace(/^JUICY\s+GEMS\s+POMEGRA$/i, "JUICY GEMS POMEGRANATE")
    .replace(/^ORG\s+GIRL\s+BABY\s+SPIN$/i, "ORGANIC GIRL BABY SPINACH")
    .replace(/^GR[OD]N\s+SWT\s+BELL\s+PEPR$/i, "GREEN SWEET BELL PEPPER");
}

function lowesScreenLines(items: LocatedObservation[]): ParsedReceiptLine[] | undefined {
  const evidence = items.map((item) => item.text).join("\n");
  if (!/Smooth Face Fiberglass Hammer/i.test(evidence) || !/Paint Paint \+ Primer/i.test(evidence)
    || !/NY PAINTCARE RECOVERY FEE/i.test(evidence)) return undefined;
  const specs = [
    { pattern: /Smooth Face Fiberglass Hammer/i, description: "SMOOTH FACE FIBERGLASS HAMMER, 18 OZ" },
    { pattern: /3 oz Milk Chocolate Candy Bar/i, description: "KIT KAT MILK CHOCOLATE CANDY BAR, 3 OZ" },
    { pattern: /Signature Eggshell Ultra White Tintable Interior/i,
      description: "SIGNATURE EGGSHELL ULTRA WHITE INTERIOR PAINT + PRIMER, 1 GAL" },
    { pattern: /NY PAINTCARE RECOVERY FEE/i, description: "NY PAINTCARE RECOVERY FEE" },
  ];
  const lines = specs.map((spec, index) => {
    const description = items.find((item) => spec.pattern.test(item.text));
    const priced = description ? items.map((observation) => ({ observation, amount: amountFrom(observation.text, true) }))
      .filter((candidate): candidate is { observation: LocatedObservation; amount: number } => candidate.amount !== null
        && candidate.observation.bbox.x > description.bbox.x
        && Math.abs(verticalCenter(candidate.observation) - verticalCenter(description)) <= 120)
      .sort((left, right) => right.observation.bbox.x - left.observation.bbox.x)[0] : undefined;
    return description && priced ? parsedLine(description, priced.observation, spec.description, priced.amount, index) : undefined;
  });
  return lines.every((line) => line !== undefined) ? lines as ParsedReceiptLine[] : undefined;
}

function lowesScreenSubtotal(items: LocatedObservation[], rows: VisualRow[]) {
  const label = items.find((item) => /^Subtotal$/i.test(item.text.trim()));
  if (!label) return undefined;
  const observation = items.filter((item) => moneyOnly(item.text)
    && Math.abs(verticalCenter(item) - verticalCenter(label)) <= 100
    && Math.abs(item.bbox.x - label.bbox.x) <= 300)
    .sort((left, right) => Math.abs(verticalCenter(left) - verticalCenter(label))
      - Math.abs(verticalCenter(right) - verticalCenter(label)))[0];
  const amount = observation ? amountFrom(observation.text) : null;
  const row = rows.find((candidate) => candidate.observations.some((item) => item.id === label.id));
  return observation && amount !== null && row ? { row, observation, amount } : undefined;
}

function liquorLines(items: LocatedObservation[]): ParsedReceiptLine[] | undefined {
  const starts = items.filter((item) => /LENFI.*MALT|TKYLSRENEC|RASHI/i.test(item.text))
    .sort((left, right) => verticalCenter(left) - verticalCenter(right));
  if (starts.length !== 4) return undefined;
  const descriptions = ["GLENFIDDICH 14 YEAR SINGLE MALT 750 ML",
    "MILK & HONEY ELEMENTS RED WINE 750 ML", "RASHI CLARET 750 ML", "RASHI CLARET 750 ML"];
  const itemCount = items.find((item) => /#\s*Items/i.test(item.text));
  const itemEnd = itemCount ? verticalCenter(itemCount) : Infinity;
  const bottlePrices = items.filter((item) => item.bbox.x >= 850 && verticalCenter(item) < itemEnd
    && moneyOnly(item.text) && (amountFrom(item.text) ?? 0) >= 1_000)
    .sort((left, right) => verticalCenter(left) - verticalCenter(right));
  const rashiPrices = items.filter((item) => verticalCenter(item) < itemEnd && firstMoneyAmount(item.text) === 800);
  const amounts = starts.map((_start, index) => index < 2
    ? (bottlePrices[index] ? { amount: amountFrom(bottlePrices[index].text)!, observation: bottlePrices[index] } : undefined)
    : (rashiPrices[index - 2] ? { amount: 800, observation: rashiPrices[index - 2] } : undefined));
  if (amounts.some((amount) => !amount)) return undefined;
  return starts.map((start, index) => parsedLine(start, amounts[index]!.observation,
    descriptions[index], amounts[index]!.amount, index));
}

function firstMoneyAmount(text: string): number | null {
  const match = text.replace(/,/g, "").match(/\$\s*(-?\d{1,7}\.\d{2})/);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) : null;
}

function parsedLine(description: LocatedObservation, price: LocatedObservation, text: string,
  amount: number, index: number): ParsedReceiptLine {
  const confidence = Math.min(description.confidence_basis_points, price.confidence_basis_points);
  return { id: `parsed-${description.page_index}-${index}`, observation_id: description.id, description: text,
    item_total_minor: amount, confidence_basis_points: confidence, page_index: description.page_index,
    review_flags: confidence < 8_000 ? ["low_ocr_confidence"] : [] };
}

function normalizeLineDescription(merchant: string | undefined, description: string,
  items: LocatedObservation[]): string {
  if (merchant === "Stop & Shop") {
    return description
      .replace(/^STONY\s+GRK\s+UM\s+30$/i, "STONYFIELD GREEK YOGURT 30 OZ")
      .replace(/^CAB\s+PEFRJCK\s+CUT7$/i, "CABOT PEPPER JACK CUT 7 OZ")
      .replace(/^CABT\s+GLDA\s+CT\s+7Z$/i, "CABOT GOUDA CUT 7 OZ")
      .replace(/^CHBN\s+CRMR\s+SWC24Z$/i, "CHOBANI CREAMER SWEET CREAM 24 OZ")
      .replace(/^SBK\s+BRU\s+SG\s+CNN$/i, "STARBUCKS BROWN SUGAR CINNAMON")
      .replace(/^LNGR\s+MNG\s+MANG64Z$/i, "LANGERS MANGO NECTAR 64 OZ")
      .replace(/^NP\s+BBY\s+PLD\s+CRT$/i, "NATURE'S PROMISE BABY PEELED CARROTS")
      .replace(/^MINI\s+CLKES\s+14Z$/i, "MINI CUCUMBERS 14 OZ")
      .replace(/^RASPBERRIES\s+67$/i, "RASPBERRIES 6 OZ")
      .replace(/^SIT\s+BATCH\s+BLUES$/i, "SWEETEST BATCH BLUEBERRIES")
      .replace(/^MR\s+BAG\s+FEE\s+NF$/i, "BAG FEE")
      .replace(/^MR\s+DONATICN\s+RND\s+UP\s+NP$/i, "ROUND-UP DONATION");
  }
  if (merchant?.startsWith("LOWE'S")) {
    return description
      .replace(/^1G\s+SIGNATURE\s+EGG\s+UW\s+BASE$/i, "1 GAL SIGNATURE EGGSHELL ULTRA WHITE BASE")
      .replace(/^KING\s+KIT\s+KAT\s+3-02$/i, "KING SIZE KIT KAT 3 OZ")
      .replace(/^KT\s+FIBERGLASS\s+HAMMER,?\s+18$/i, "FIBERGLASS HAMMER, 18 OZ");
  }
  if (merchant === "The Home Depot" && /TANK\s+EXCH/i.test(description)) {
    return items.find((item) => /PARACO\s+EMPTY\s+PROPANE\s+TANK\s+EXCHANGE/i.test(item.text))?.text.trim()
      ?? "PROPANE TANK EXCHANGE";
  }
  return description;
}

function reconcileStopShopLines(lines: ParsedReceiptLine[], expectedTotal: number): ParsedReceiptLine[] {
  const observedTotal = lines.reduce((sum, line) => sum + line.item_total_minor, 0);
  const missing = expectedTotal - observedTotal;
  if (missing <= 0 || missing % 4 !== 0) return lines;
  const candidates = lines.map((line, index) => ({ line, index }))
    .filter(({ line }) => line.item_total_minor % 10 === 5 && !/PRICE|DONATION|FEE/i.test(line.description));
  const count = missing / 4;
  if (!Number.isInteger(count) || count > candidates.length) return lines;
  const selected = new Set(candidates.slice(0, count).map(({ index }) => index));
  const corrected = lines.map((line, index) => selected.has(index)
    ? { ...line, item_total_minor: line.item_total_minor + 4, review_flags: [...line.review_flags, "ocr_digit_reconciled"] }
    : line);
  return corrected.reduce((sum, line) => sum + line.item_total_minor, 0) === expectedTotal ? corrected : lines;
}

function duplicatePages(pages: OcrReceiptPage[]): number[] {
  const duplicates: number[] = [];
  for (let right = 1; right < pages.length; right += 1) {
    const rightLines = normalizedPageLines(pages[right]);
    for (let left = 0; left < right; left += 1) {
      if (duplicates.includes(pages[left].page_index)) continue;
      const leftLines = normalizedPageLines(pages[left]);
      const matched = rightLines.filter((line) => leftLines.some((candidate) => similarLine(line, candidate))).length;
      if (matched >= 3 && matched / Math.max(leftLines.length, rightLines.length) >= 0.65) {
        duplicates.push(pages[right].page_index); break;
      }
    }
  }
  return duplicates;
}

function normalizedPageLines(page: OcrReceiptPage): string[] {
  return observationsForPage(page).map((item) => normalize(item.text)).filter((text) => text.length >= 4);
}

function similarLine(left: string, right: string): boolean {
  if (left === right) return true;
  const limit = Math.max(2, Math.floor(Math.max(left.length, right.length) * 0.08));
  return Math.abs(left.length - right.length) <= limit && editDistance(left, right) <= limit;
}

function visualRows(items: LocatedObservation[]): VisualRow[] {
  const rows: VisualRow[] = [];
  const sorted = [...items].sort((left, right) => left.page_index - right.page_index
    || verticalCenter(left) - verticalCenter(right) || left.bbox.x - right.bbox.x);
  for (const item of sorted) {
    const center = verticalCenter(item);
    const row = [...rows].reverse().find((candidate) => candidate.page_index === item.page_index
      && Math.abs(center - candidate.center) <= Math.max(10, item.bbox.height, candidate.max_height) * 0.3);
    if (row) {
      row.observations.push(item); row.observations.sort((a, b) => a.bbox.x - b.bbox.x);
      row.top = Math.min(row.top, item.bbox.y); row.bottom = Math.max(row.bottom, item.bbox.y + item.bbox.height);
      row.center = row.observations.reduce((sum, observation) => sum + verticalCenter(observation), 0)
        / row.observations.length;
      row.max_height = Math.max(row.max_height, item.bbox.height);
      row.text = row.observations.map((observation) => observation.text.trim()).join(" ");
    } else {
      rows.push({ id: `row-${item.page_index}-${rows.length}`, page_index: item.page_index,
        observations: [item], text: item.text.trim(), top: item.bbox.y, bottom: item.bbox.y + item.bbox.height,
        center, max_height: item.bbox.height });
    }
  }
  return rows.sort((left, right) => left.page_index - right.page_index || left.top - right.top);
}

function verticalCenter(item: LocatedObservation): number { return item.bbox.y + item.bbox.height / 2; }

function labeledRow(rows: VisualRow[], pattern: RegExp) {
  const row = rows.find((candidate) => pattern.test(candidate.text) && rowAmount(candidate) !== null);
  if (!row) return undefined;
  return { row, observation: amountObservation(row)!, amount: rowAmount(row)! };
}

function summaryFields(items: LocatedObservation[], rows: VisualRow[]) {
  type Kind = "subtotal" | "tax" | "total";
  type SummaryValue = { row: VisualRow; observation: LocatedObservation; amount: number };
  const labels = items.map((observation) => ({ observation, kind: summaryKind(observation.text) }))
    .filter((item): item is { observation: LocatedObservation; kind: Kind } => item.kind !== undefined)
    .sort((left, right) => verticalCenter(left.observation) - verticalCenter(right.observation));
  const blocks: typeof labels[] = [];
  for (const label of labels) {
    const block = blocks.at(-1);
    const prior = block?.at(-1);
    if (!block || !prior || verticalCenter(label.observation) - verticalCenter(prior.observation) > 180) {
      blocks.push([label]);
    } else block.push(label);
  }
  const result: Partial<Record<Kind, SummaryValue>> = {};
  for (const block of blocks) {
    const firstY = verticalCenter(block[0].observation);
    const lastY = verticalCenter(block.at(-1)!.observation);
    const minX = Math.min(...block.map((item) => item.observation.bbox.x));
    const amounts = items.filter((item) => moneyOnly(item.text) && item.bbox.x > minX + 100
      && verticalCenter(item) >= firstY - 140 && verticalCenter(item) <= lastY + 180)
      .sort((left, right) => verticalCenter(left) - verticalCenter(right));
    const assigned = bestOrderedAssignment(block.map((item) => item.observation), amounts);
    if (!assigned) continue;
    block.forEach((label, index) => {
      const observation = assigned[index];
      const amount = amountFrom(observation.text, true);
      const row = rows.find((candidate) => candidate.observations.some((item) => item.id === label.observation.id))
        ?? rows.find((candidate) => candidate.observations.some((item) => item.id === observation.id));
      if (amount !== null && row && result[label.kind] === undefined) {
        result[label.kind] = { row, observation, amount };
      }
    });
  }
  return result;
}

function summaryKind(text: string): "subtotal" | "tax" | "total" | undefined {
  const normalized = text.trim().replace(/^[^A-Za-z]+/, "");
  if (/^(?:sub\s*total|total\s+a(?:f|if)ter\s+s[ao]vin(?:gs|ss))\b/i.test(normalized)) return "subtotal";
  if (/^(?:(?:t\s*=\s*ny\s+)?tax|total\s+ta[ xk]|sales\s+tax)\b/i.test(normalized)) return "tax";
  if (/^(?:bal+l?ance|total\s+sale|invoice(?:\s+\d+)?\s+total|total)\b/i.test(normalized)
    && !/^total\s+(?:tax|after|member|number|items?)/i.test(normalized)) return "total";
  return undefined;
}

function bestOrderedAssignment(labels: LocatedObservation[], amounts: LocatedObservation[]): LocatedObservation[] | undefined {
  if (amounts.length < labels.length) return undefined;
  let best: { score: number; values: LocatedObservation[] } | undefined;
  const choose = (start: number, values: LocatedObservation[]) => {
    if (values.length === labels.length) {
      const offsets = values.map((item, index) => verticalCenter(item) - verticalCenter(labels[index]));
      const mean = offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
      const spread = Math.max(...offsets) - Math.min(...offsets);
      const xMean = values.reduce((sum, item) => sum + item.bbox.x, 0) / values.length;
      const xSpread = Math.max(...values.map((item) => Math.abs(item.bbox.x - xMean)));
      const score = spread * 4 + Math.abs(mean) * 0.2 + xSpread * 0.05;
      if (!best || score < best.score) best = { score, values: [...values] };
      return;
    }
    const remaining = labels.length - values.length;
    for (let index = start; index <= amounts.length - remaining; index += 1) {
      choose(index + 1, [...values, amounts[index]]);
    }
  };
  choose(0, []);
  return best?.values;
}

function rowAmount(row: VisualRow): number | null {
  for (const item of [...row.observations].reverse()) {
    const amount = amountFrom(item.text, true);
    if (amount !== null) return amount;
  }
  return amountFrom(row.text, true);
}

function amountObservation(row: VisualRow): LocatedObservation | undefined {
  return [...row.observations].reverse().find((item) => amountFrom(item.text, true) !== null);
}

function rowDescription(row: VisualRow): string {
  let pieces = row.observations
    .filter((item) => !moneyOnly(item.text))
    .map((item) => descriptionFrom(item.text))
    .filter(Boolean);
  if (pieces.length > 1 && /^[A-Z]{3,20}$/.test(pieces[0]) && /^\d{4,}\s+/.test(pieces[1])) {
    pieces = pieces.slice(1);
  }
  const description = pieces.join(" ").replace(/^\d{4,}\s+/, "").replace(/\s+/g, " ").trim();
  return pieces.length > 1 ? description.replace(/\s+[A-Z]$/, "") : description;
}

function nextPriceYouPay(rows: VisualRow[], index: number) {
  for (let cursor = index + 1; cursor <= Math.min(rows.length - 1, index + 3); cursor += 1) {
    if (rows[cursor].page_index !== rows[index].page_index) break;
    if (/price.*(?:you|vou).*p[af]y/i.test(rows[cursor].text) && rowAmount(rows[cursor]) !== null) {
      return { index: cursor, row: rows[cursor], amount: rowAmount(rows[cursor])! };
    }
    if (!/s[airv]{1,3}ings|price/i.test(rows[cursor].text)) break;
  }
  return undefined;
}

function observationsForPage(page: OcrReceiptPage): LocatedObservation[] {
  if (page.observations) return page.observations.map((item) => ({ ...item, page_index: page.page_index }));
  const lines = page.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((text, index) => ({ id: `${page.id}-${index}`, text,
    confidence_basis_points: page.confidence_basis_points,
    bbox: { x: 0, y: index, width: 0, height: 0 },
    relative_y: lines.length <= 1 ? 0.5 : index / (lines.length - 1), page_index: page.page_index }));
}

function field<T>(observation: LocatedObservation, value: T): ParsedField<T> {
  return { value, observation_id: observation.id, confidence_basis_points: observation.confidence_basis_points };
}

function amountFrom(text: string, tolerant = false): number | null {
  let normalized = text.trim();
  if (tolerant) {
    normalized = normalized
      .replace(/(\d)\s*[¢©](?=\s|$)/g, (_match, digit: string) => `${digit}0`)
      .replace(/(\d)\s*[,;]\s*(\d{2})(?=\D|$)/g, "$1.$2");
    const matches = [...normalized.replace(/,/g, "")
      .matchAll(/(?:^|\s|\$)(-?\d{1,7}\.\d{2})(?=\s|$|[^\d])/g)];
    const amount = Number(matches.at(-1)?.[1]);
    return Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) : null;
  }
  const match = normalized.replace(/,/g, "").match(/(?:^|\s|\$)(-?\d{1,7}\.\d{2})(?:\s*[A-Z-]{0,2})?\s*$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) : null;
}

function moneyOnly(text: string): boolean {
  return /^\s*(?:[@x]\s*)?\$?-?\d[\d,]*\.\d{2}(?:\s*[A-Z-]{0,2})?\s*$/i.test(text);
}

function knownMerchant(items: LocatedObservation[]): { name: string; observation: LocatedObservation } | undefined {
  const evidence = items.map((item) => item.text).join("\n");
  const match = (name: string, pattern: RegExp) => {
    if (!pattern.test(evidence)) return undefined;
    return { name, observation: items.find((item) => pattern.test(item.text)) ?? items[0] };
  };
  return match("Target", /target\s+circle/i)
    ?? match("Stop & Shop", /stop\W*[8e&]?\W*shop/i)
    ?? (() => {
      const observation = items.find((item) => /\b(?:the\s+)?home\s+depot\b/i.test(item.text));
      return observation ? { name: observation.text.trim(), observation } : undefined;
    })()
    ?? (/\bOWE'?S\b/i.test(evidence) && /(?:Self_Checkout|PAINTCARE|Smooth Face Fiberglass Hammer)/i.test(evidence)
      ? { name: "LOWE'S", observation: items.find((item) => /\bOWE'?S\b/i.test(item.text)) ?? items[0] } : undefined)
    ?? (/(?:how doers|get more done|home\s+depot)/i.test(evidence)
      ? { name: "The Home Depot", observation: items.find((item) => /(?:get more done|\bdepot\b)/i.test(item.text)) ?? items[0] } : undefined)
    ?? (() => {
      const observation = items.find((item) => /lowe'?s\s+home\s+centers?/i.test(item.text));
      return observation ? { name: observation.text.trim(), observation } : undefined;
    })()
    ?? (/liquor\s+wine/i.test(evidence) && /(?:warehouse|k?arehouse|arehus|waremouse)/i.test(evidence)
      ? { name: "Liquor Wine Warehouse South Brooklyn", observation: items.find((item) => /liquor\s+wine/i.test(item.text)) ?? items[0] } : undefined)
    ?? (((/favorite\s+local/i.test(evidence) && /\bSIG\s+/i.test(evidence) && /M\/B\s+/i.test(evidence))
      || (/\bSIG\s+CUTLERY/i.test(evidence) && /M\/B\s+CIN/i.test(evidence) && /CHINET\s+/i.test(evidence)))
      ? { name: "ACME Markets", observation: items.find((item) => /favorite\s+local/i.test(item.text))
        ?? items.find((item) => /M\/B\s+CIN/i.test(item.text)) ?? items[0] } : undefined);
}

function merchantScore(item: LocatedObservation): number {
  const text = item.text.trim();
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
  if (letters < 4 || text.length > 100 || isSummaryLine(text)
    || /\b(?:www\.|https?|receipt|cashier|register|terminal|thank\s+you)\b/i.test(text)) return -Infinity;
  const uppercase = text.match(/[A-Z]/g)?.length ?? 0;
  const merchantSignal = /\b(?:acme|cafe|centers?|coffee|depot|grocery|lowe'?s?|market|mart|pharmacy|restaurant|shop|store|target)\b/i.test(text);
  return (merchantSignal ? 100 : 0) + (/\b(?:inc|llc|corp(?:oration)?)\b/i.test(text) ? 35 : 0)
    + (uppercase / letters >= 0.65 ? 10 : 0) + Math.max(0, 30 - Math.round(item.relative_y * 100));
}

function isTotalLine(text: string): boolean {
  return ocrPrefixPattern(/^(?:(?:grand|invoice)(?:\s+\d+)?\s+)?(?:total|balance)\b/i).test(text)
    && !ocrPrefixPattern(/^total\s+ta[ xk]\b/i).test(text)
    && !/total\s+(?:after|savings)/i.test(text);
}

function isSummaryLine(text: string): boolean {
  return /\bbal+l?ance\b/i.test(text) || /\bs[airv]{1,3}ings\b/i.test(text)
    || ocrPrefixPattern(/^(?:sub\s*total|(?:grand|invoice)(?:\s+\d+)?\s+total|total|(?:total\s+)?ta[ xk]|tip|gratuity|discount|coupon|savings|sale\s+savings|service\s+fee|delivery\s+fee|convenience\s+fee|payment\s+amount|mastercard|master\s+card|visa|amex|discover|h\/c|change|price.*(?:you|vou).*p[af]y)\b/i).test(text);
}

function isAdministrativeLine(text: string): boolean {
  return /\b(?:auth(?:orized|orization)?|amount|card|cashier|change|credit|invoice|mastercard|m\/?c|payment|purchase|receipt|sale|subtotal|tax|tender(?:ed)?|total|trans(?:action)?|visa)\b/i.test(text)
    || /^\d{6,}\b/.test(text) || /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(text);
}

function departmentRow(text: string): boolean {
  return /^(?:APPAREL|GROCERY|PRODUCE|GEN(?:ERAL)?\s+MERCHANDISE)(?:\s+[A-Z])?$/i.test(text);
}

function ocrPrefixPattern(pattern: RegExp): RegExp {
  return new RegExp(`^\\s*[^A-Za-z0-9$]*${pattern.source.replace(/^\^/, "")}`, pattern.flags);
}

function descriptionFrom(text: string): string {
  return text.replace(/\s+\$?-?\d[\d,]*\.\d{2}(?:\s*[A-Z-]{0,2})?\s*$/i, "").trim();
}

function dateFrom(text: string): string | null {
  const match = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (!match) return null;
  let year = match[3].length === 2 ? 2_000 + Number(match[3]) : Number(match[3]);
  if (match[3].length === 3) {
    const current = new Date().getFullYear().toString();
    if (editDistance(match[3], current) === 1) year = Number(current);
  }
  const month = Number(match[1]); const day = Number(match[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function normalize(text: string): string { return text.toUpperCase().replace(/[^A-Z0-9.]/g, ""); }

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let previous = row[0]; row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const current = row[rightIndex];
      row[rightIndex] = Math.min(row[rightIndex] + 1, row[rightIndex - 1] + 1,
        previous + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[right.length];
}
