# Five-Tab Receipt Navigation Design

FinTracka’s iPhone viewer keeps five persistent bottom destinations: Overview, Transactions, Planning, Savings, and Reports. Receipt scanning is transaction work, so its entry point moves to a prominent action at the top of Transactions instead of occupying a sixth tab.

Receipt inbox, capture, and review remain full routes. While any `/receipts` route is open, Transactions stays highlighted in the bottom bar. The fixed bar remains one row above the iPhone safe area so Safari cannot cover a wrapped item and page content cannot receive a tap intended for navigation.

Desktop navigation remains unchanged apart from the same five destinations and the receipt entry point in Transactions. No new dependency or route contract is introduced.
