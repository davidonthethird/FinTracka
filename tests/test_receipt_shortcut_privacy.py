from __future__ import annotations

import plistlib
from pathlib import Path


SHORTCUT = Path(__file__).parents[1] / "shortcuts" / "FinTracka Receipt Model Comparison.xml"
PHOTO_UUID = "11000000-0000-4000-8000-000000000004"
RAW_OCR_UUID = "11000000-0000-4000-8000-000000000005"
RAW_ON_DEVICE_UUID = "11000000-0000-4000-8000-000000000006"
RAW_CLOUD_UUID = "11000000-0000-4000-8000-000000000007"
PLAIN_TEXT_UUIDS = {
    "text": "11000000-0000-4000-8000-000000000019",
    "on_device_model_result": "11000000-0000-4000-8000-000000000020",
    "private_cloud_compute_model_result": "11000000-0000-4000-8000-000000000021",
}


def _dictionary_items(field: dict) -> list[dict]:
    return field["Value"]["WFDictionaryFieldValueItems"]


def _literal(field: dict) -> str:
    return field["Value"]["string"]


def test_receipt_upload_contains_only_plain_text_snapshots() -> None:
    with SHORTCUT.open("rb") as source:
        workflow = plistlib.load(source)

    actions = workflow["WFWorkflowActions"]
    upload = next(
        action for action in actions
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.downloadurl"
    )
    parameters = upload["WFWorkflowActionParameters"]
    payload = {
        _literal(item["WFKey"]): item["WFValue"]
        for item in _dictionary_items(parameters["WFJSONValues"])
    }

    for key, expected_uuid in PLAIN_TEXT_UUIDS.items():
        assert payload[key]["Value"]["OutputUUID"] == expected_uuid

    serialized_upload = plistlib.dumps(upload)
    for forbidden_uuid in (PHOTO_UUID, RAW_OCR_UUID, RAW_ON_DEVICE_UUID, RAW_CLOUD_UUID):
        assert forbidden_uuid.encode() not in serialized_upload

    text_actions = {
        action["WFWorkflowActionParameters"].get("UUID")
        for action in actions
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.gettext"
    }
    assert set(PLAIN_TEXT_UUIDS.values()) <= text_actions


def test_apple_model_routes_use_saved_shortcuts_values() -> None:
    with SHORTCUT.open("rb") as source:
        workflow = plistlib.load(source)

    models = [
        action["WFWorkflowActionParameters"]["WFLLMModel"]
        for action in workflow["WFWorkflowActions"]
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.askllm"
    ]
    assert models == ["Apple Intelligence on Device", "Apple Intelligence"]
