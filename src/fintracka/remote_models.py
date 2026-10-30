from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, StrictInt, field_validator, model_validator


class RemoteReadModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)


class RemoteOverview(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    cash_minor: int
    card_liabilities_minor: int
    net_position_minor: int
    income_minor: int
    spending_minor: int
    cash_income_minor: int
    cash_spending_minor: int
    cash_transfer_minor: int
    opening_cash_minor: int | None
    off_bank_cash_spending_minor: int


class RemotePlanningSubcategory(RemoteReadModel):
    subcategory: str
    actual_minor: int


class RemoteTrendPoint(RemoteReadModel):
    month: str
    amount_minor: int


class RemotePlanningCategory(RemoteReadModel):
    category_id: str
    category: str
    historical_average_minor: int
    target_minor: int
    actual_minor: int
    remaining_minor: int
    status: str
    percent_used_basis_points: int | None
    subcategories: tuple[RemotePlanningSubcategory, ...]
    trend: tuple[RemoteTrendPoint, ...]
    transaction_ids: tuple[str, ...]


class RemotePlanningSnapshot(RemoteReadModel):
    month: str
    target_total_minor: int
    actual_total_minor: int
    remaining_total_minor: int
    planned_income_total_minor: int
    surplus_shortfall_minor: int
    categories: tuple[RemotePlanningCategory, ...]


class RemoteSavingsAccount(RemoteReadModel):
    account_id: str
    name: str
    owner: str
    balance_minor: int
    pool: str | None


class RemoteManualAsset(RemoteReadModel):
    id: str
    title: str
    kind: str
    owner: str
    current_value_minor: int
    savings_pool: str | None


class RemoteSavingsActivity(RemoteReadModel):
    transaction_id: str
    local_date: str
    title: str
    kind: str
    amount_minor: int
    owner: str


class RemoteSavingsMonth(RemoteReadModel):
    month: str
    additions_minor: int
    spending_draw_minor: int
    closing_minor: int


class RemoteSavingsGoal(RemoteReadModel):
    goal_id: str
    name: str
    pool: str
    owner: str
    balance_minor: int
    monthly_target_minor: int
    monthly_saved_minor: int
    monthly_funded_basis_points: int | None
    overall_target_minor: int | None
    overall_remaining_minor: int | None
    months: tuple[RemoteSavingsMonth, ...]


class RemoteSavingsGoalLedger(RemoteReadModel):
    regular_minor: int
    retirement_minor: int
    combined_minor: int
    goals: tuple[RemoteSavingsGoal, ...]


class RemoteSavingsSnapshot(RemoteReadModel):
    month: str
    owner: str | None
    connected_total_minor: int
    manual_savings_minor: int
    investments_minor: int
    other_assets_minor: int
    combined_total_minor: int
    contributions_minor: int
    withdrawals_minor: int
    earnings_minor: int
    accounts: tuple[RemoteSavingsAccount, ...]
    manual_assets: tuple[RemoteManualAsset, ...]
    activity: tuple[RemoteSavingsActivity, ...]
    goal_ledger: RemoteSavingsGoalLedger | None


class RemoteCashFlow(RemoteReadModel):
    income_minor: int
    spending_minor: int
    net_minor: int


class RemoteReportCategory(RemoteReadModel):
    category_id: str | None
    category: str
    amount_minor: int


class RemoteReportOwner(RemoteReadModel):
    owner: str
    amount_minor: int


class RemoteFlowNode(RemoteReadModel):
    id: str
    label: str
    kind: str
    amount_minor: int
    entry_ids: tuple[str, ...]


class RemoteFlowLink(RemoteReadModel):
    source: int
    target: int
    amount_minor: int
    entry_ids: tuple[str, ...]


class RemoteFlowEntry(RemoteReadModel):
    id: str
    transaction_id: str
    local_date: str
    merchant: str | None
    description: str
    category: str
    category_id: str | None
    subcategory_id: str | None
    subcategory: str | None
    amount_minor: int
    currency: str
    spending_owner: str | None


class RemoteCashFlowPaths(RemoteReadModel):
    month: str
    nodes: tuple[RemoteFlowNode, ...]
    links: tuple[RemoteFlowLink, ...]
    entries: tuple[RemoteFlowEntry, ...] = ()


class RemoteReportSnapshot(RemoteReadModel):
    cash_flow: RemoteCashFlow
    spending_by_category: tuple[RemoteReportCategory, ...]
    spending_by_owner: tuple[RemoteReportOwner, ...]
    cash_flow_paths: RemoteCashFlowPaths | None = None


class RemoteSourceFreshness(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str
    status: str
    last_success_at: str | None
    error_code: str | None


class RemoteTransaction(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    local_date: str
    amount_minor: int
    currency: str
    description: str
    merchant: str | None
    category_id: str | None
    category: str | None
    subcategory_id: str | None
    subcategory: str | None
    spending_owner: str | None
    account_name: str
    account_type: str
    account_subtype: str | None
    account_mask: str | None
    institution_name: str | None
    pending: bool
    manual_cash: bool
    is_cash_withdrawal: bool
    updated_at: str


class RemoteTransactionV2(RemoteTransaction):
    classification_revision: StrictInt

    @field_validator("classification_revision")
    @classmethod
    def revision_is_non_negative(cls, value: int) -> int:
        if value < 0:
            raise ValueError("classification revision must be non-negative")
        return value


class RemoteCounts(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    transactions: int
    sources: int
    aggregate_months: int
    detailed_months: int


class RemoteSnapshotV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal[1]
    snapshot_id: str
    source_sequence: int
    captured_at: str
    source_last_sync_at: str | None
    sources: tuple[RemoteSourceFreshness, ...]
    history_start: str
    history_end: str
    overview: dict[str, RemoteOverview]
    transactions: tuple[RemoteTransaction, ...]
    planning: dict[str, RemotePlanningSnapshot]
    savings: dict[str, RemoteSavingsSnapshot]
    reports: dict[str, RemoteReportSnapshot]
    counts: RemoteCounts


class RemoteCapabilities(RemoteReadModel):
    commands: dict[str, tuple[StrictInt, ...]]

    @field_validator("commands")
    @classmethod
    def supported_commands_only(
        cls, value: dict[str, tuple[int, ...]]
    ) -> dict[str, tuple[int, ...]]:
        if set(value) - {"transaction.set_classification"}:
            raise ValueError("unsupported remote command capability")
        if value.get("transaction.set_classification") not in (None, (1,), (1, 2)):
            raise ValueError("unsupported transaction classification command version")
        return value


class RemoteTaxonomyCategory(RemoteReadModel):
    id: str
    name: str
    category_type: Literal["income", "expense", "transfer"]
    reporting_behavior: Literal["ordinary", "expense_offset", "excluded", "income"]
    group_id: str | None
    group: str | None
    sort_order: int


class RemoteTaxonomySubcategory(RemoteReadModel):
    id: str
    category_id: str
    name: str
    sort_order: int


class RemoteTaxonomy(RemoteReadModel):
    categories: tuple[RemoteTaxonomyCategory, ...]
    subcategories: tuple[RemoteTaxonomySubcategory, ...]

    @model_validator(mode="after")
    def children_reference_published_parents(self) -> "RemoteTaxonomy":
        category_ids = {item.id for item in self.categories}
        if any(item.category_id not in category_ids for item in self.subcategories):
            raise ValueError("subcategory references an unpublished category")
        return self


class RemoteSnapshotV2(RemoteSnapshotV1):
    schema_version: Literal[2]
    transactions: tuple[RemoteTransactionV2, ...]
    capabilities: RemoteCapabilities
    taxonomy: RemoteTaxonomy


RemoteSnapshot = RemoteSnapshotV1 | RemoteSnapshotV2
