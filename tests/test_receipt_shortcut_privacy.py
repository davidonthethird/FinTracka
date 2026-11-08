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


def test_receipt_handoff_is_local_and_contains_only_plain_text_snapshots() -> None:
    with SHORTCUT.open("rb") as source:
        workflow = plistlib.load(source)

    actions = workflow["WFWorkflowActions"]
    assert all(action["WFWorkflowActionIdentifier"] != "is.workflow.actions.downloadurl"
               for action in actions)
    serialized_workflow = plistlib.dumps(workflow)
    assert b"upload_url" not in serialized_workflow

    base64_inputs = {
        action["WFWorkflowActionParameters"]["WFInput"]["Value"].get("OutputUUID")
        for action in actions
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.base64encode"
    }
    assert set(PLAIN_TEXT_UUIDS.values()) <= base64_inputs

    handoff = next(action for action in actions
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.gettext"
        and action["WFWorkflowActionParameters"].get("CustomOutputName") == "FinTracka Receipt Handoff")
    handoff_bytes = plistlib.dumps(handoff)
    assert b"fintracka_receipt_handoff/v1" in handoff_bytes
    handoff_value = handoff["WFWorkflowActionParameters"]["WFTextActionText"]["Value"]
    assert handoff_value["string"].count('"duration_ms":"\ufffc"') == 2
    assert set(handoff_value["attachmentsByRange"]) == {
        f"{{{index}, 1}}" for index, character in enumerate(handoff_value["string"])
        if character == "\ufffc"
    }
    for forbidden_uuid in (PHOTO_UUID, RAW_OCR_UUID, RAW_ON_DEVICE_UUID, RAW_CLOUD_UUID):
        assert forbidden_uuid.encode() not in handoff_bytes

    clipboard = next(action for action in actions
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.setclipboard")
    clipboard_input = clipboard["WFWorkflowActionParameters"]["WFInput"]["Value"]
    assert clipboard_input["OutputUUID"] == handoff["WFWorkflowActionParameters"]["UUID"]

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
