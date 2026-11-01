import type {
  AllocationBasis,
  AllocationResult,
  ReceiptReconciliation,
  ReceiptReconciliationInput,
} from "./types";

function requireMinor(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
}

export function allocateMinor(totalMinor: number, bases: AllocationBasis[]): AllocationResult[] {
  requireMinor(totalMinor, "allocation total");
  const seen = new Set<string>();
  for (const basis of bases) {
    if (!basis.id || seen.has(basis.id)) {
      throw new Error("allocation ids must be nonempty and unique");
    }
    seen.add(basis.id);
    requireMinor(basis.basis_minor, `basis for ${basis.id}`);
  }

  if (totalMinor === 0) {
    return bases.map(({ id }) => ({ id, amount_minor: 0 }));
  }
  const basisTotal = bases.reduce((sum, basis) => sum + basis.basis_minor, 0);
  if (!Number.isSafeInteger(basisTotal) || basisTotal <= 0) {
    throw new Error("positive allocation requires a positive basis");
  }

  const allocations = bases.map((basis, index) => {
    const numerator = totalMinor * basis.basis_minor;
    if (!Number.isSafeInteger(numerator)) {
      throw new Error("allocation exceeds safe integer range");
    }
    return {
      id: basis.id,
      index,
      amount_minor: Math.floor(numerator / basisTotal),
      remainder: numerator % basisTotal,
    };
  });
  let remaining = totalMinor - allocations.reduce((sum, allocation) => sum + allocation.amount_minor, 0);
  const byRemainder = [...allocations].sort(
    (left, right) => right.remainder - left.remainder || left.index - right.index,
  );
  for (let index = 0; index < remaining; index += 1) {
    byRemainder[index].amount_minor += 1;
  }
  return allocations.map(({ id, amount_minor }) => ({ id, amount_minor }));
}

function amountsById(totalMinor: number, bases: AllocationBasis[]): Map<string, number> {
  return new Map(allocateMinor(totalMinor, bases).map(({ id, amount_minor }) => [id, amount_minor]));
}

export function reconcileReceipt(input: ReceiptReconciliationInput): ReceiptReconciliation {
  for (const [label, value] of Object.entries({
    receipt_discount_minor: input.receipt_discount_minor,
    tax_minor: input.tax_minor,
    tip_minor: input.tip_minor,
    fees_minor: input.fees_minor,
    total_minor: input.total_minor,
  })) {
    requireMinor(value, label);
  }

  const seen = new Set<string>();
  const lineBases = input.lines.map((line) => {
    if (!line.id || seen.has(line.id)) {
      throw new Error("receipt line ids must be nonempty and unique");
    }
    seen.add(line.id);
    requireMinor(line.item_total_minor, `item total for ${line.id}`);
    requireMinor(line.line_discount_minor, `line discount for ${line.id}`);
    if (line.line_discount_minor > line.item_total_minor) {
      throw new Error(`line discount exceeds item total for ${line.id}`);
    }
    return { id: line.id, basis_minor: line.item_total_minor - line.line_discount_minor };
  });

  const receiptDiscounts = amountsById(input.receipt_discount_minor, lineBases);
  const postDiscountBases = lineBases.map((basis) => ({
    id: basis.id,
    basis_minor: basis.basis_minor - (receiptDiscounts.get(basis.id) ?? 0),
  }));
  if (postDiscountBases.some((basis) => basis.basis_minor < 0)) {
    throw new Error("receipt discount exceeds the receipt item basis");
  }

  const taxableBases = postDiscountBases.filter(
    (basis) => input.lines.find((line) => line.id === basis.id)?.taxable,
  );
  if (input.tax_minor > 0 && taxableBases.reduce((sum, basis) => sum + basis.basis_minor, 0) === 0) {
    throw new Error("tax allocation requires a positive taxable basis");
  }
  const taxes = amountsById(input.tax_minor, taxableBases);
  const tips = amountsById(input.tip_minor, postDiscountBases);
  const fees = amountsById(input.fees_minor, postDiscountBases);

  const lines = input.lines.map((line) => {
    const receiptDiscount = receiptDiscounts.get(line.id) ?? 0;
    const tax = taxes.get(line.id) ?? 0;
    const tip = tips.get(line.id) ?? 0;
    const fee = fees.get(line.id) ?? 0;
    return {
      id: line.id,
      receipt_discount_minor: receiptDiscount,
      tax_minor: tax,
      tip_minor: tip,
      fees_minor: fee,
      final_minor: line.item_total_minor - line.line_discount_minor - receiptDiscount + tax + tip + fee,
    };
  });
  const calculatedTotal = lines.reduce((sum, line) => sum + line.final_minor, 0);
  if (!Number.isSafeInteger(calculatedTotal)) {
    throw new Error("reconciled total exceeds safe integer range");
  }
  return {
    lines,
    calculated_total_minor: calculatedTotal,
    difference_minor: input.total_minor - calculatedTotal,
  };
}
