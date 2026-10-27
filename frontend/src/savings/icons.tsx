import { Car, ChartNoAxesColumnIncreasing, Coins, Gamepad2, Gift, House, Palmtree, PiggyBank, Shield, ShoppingBag, WalletCards } from "lucide-react";

const icons = { piggy_bank: PiggyBank, shield: Shield, palm_tree: Palmtree, shopping_bag: ShoppingBag, gamepad: Gamepad2, house: House, gift: Gift, car: Car, chart: ChartNoAxesColumnIncreasing, wallet: WalletCards, coins: Coins } as const;

export function SavingsIcon({ name }: { name: string }) {
  const Icon = icons[name as keyof typeof icons] || PiggyBank;
  return <Icon aria-hidden="true" size={22} strokeWidth={2} />;
}
