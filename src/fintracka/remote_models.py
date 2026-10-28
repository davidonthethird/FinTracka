from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, RootModel


class RemoteReadModel(RootModel[dict[str, Any]]):
    model_config = ConfigDict(frozen=True)

    def __getitem__(self, key: str) -> Any:
        return self.root[key]


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


class RemotePlanningSnapshot(RemoteReadModel):
    pass


class RemoteSavingsSnapshot(RemoteReadModel):
    pass


class RemoteReportSnapshot(RemoteReadModel):
    pass


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
