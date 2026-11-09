from __future__ import annotations

import plistlib
from pathlib import Path


SHORTCUT = Path(__file__).parents[1] / "shortcuts" / "FinTracka Receipt Model Comparison.xml"
PHOTO_UUID = "11000000-0000-4000-8000-000000000004"
RAW_OCR_UUID = "11000000-0000-4000-8000-000000000005"
RAW_ON_DEVICE_UUID = "11000000-0000-4000-8000-000000000006"
RAW_CLOUD_UUID = "11000000-0000-4000-8000-000000000007"
PLAIN_TEXT_UUIDS = {
    "text": "11000000-0000-4000-8000-000000000023",
    "on_device_model_result": "11000000-0000-4000-8000-000000000025",
    "private_cloud_compute_model_result": "11000000-0000-4000-8000-000000000027",
}
MATCH_UUIDS = {
    "11000000-0000-4000-8000-000000000022",
    "11000000-0000-4000-8000-000000000024",
    "11000000-0000-4000-8000-000000000026",
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
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.text.combine"
    }
    assert set(PLAIN_TEXT_UUIDS.values()) <= text_actions

    match_actions = {
        action["WFWorkflowActionParameters"].get("UUID")
        for action in actions
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.text.match"
    }
    assert MATCH_UUIDS <= match_actions


def test_apple_model_routes_use_saved_shortcuts_values() -> None:
    with SHORTCUT.open("rb") as source:
        workflow = plistlib.load(source)

    models = [
        action["WFWorkflowActionParameters"]["WFLLMModel"]
        for action in workflow["WFWorkflowActions"]
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.askllm"
    ]
    assert models == ["Apple Intelligence on Device", "Apple Intelligence"]


def test_receipt_upload_only_reports_success_after_server_confirmation() -> None:
    with SHORTCUT.open("rb") as source:
        workflow = plistlib.load(source)

    actions = workflow["WFWorkflowActions"]
    upload_index = next(
        index for index, action in enumerate(actions)
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.downloadurl"
    )
    upload_uuid = actions[upload_index]["WFWorkflowActionParameters"]["UUID"]
    import_id_index = next(
        index for index, action in enumerate(actions)
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.getvalueforkey"
        and action["WFWorkflowActionParameters"].get("WFDictionaryKey") == "import_id"
    )
    import_id = actions[import_id_index]["WFWorkflowActionParameters"]

    assert import_id_index > upload_index
    assert import_id["WFInput"]["Value"]["OutputUUID"] == upload_uuid

    conditional_index = next(
        index for index, action in enumerate(actions)
        if index > import_id_index
        and action["WFWorkflowActionIdentifier"] == "is.workflow.actions.conditional"
        and action["WFWorkflowActionParameters"].get("WFControlFlowMode") == 0
    )
    conditional = actions[conditional_index]["WFWorkflowActionParameters"]
    assert conditional["WFCondition"] == 100
    assert conditional["WFInput"]["Variable"]["Value"]["OutputUUID"] == import_id["UUID"]

    success_index = next(
        index for index, action in enumerate(actions)
        if index > conditional_index
        and "sent to FinTracka" in str(action["WFWorkflowActionParameters"].get("Text", ""))
    )
    otherwise_index = next(
        index for index, action in enumerate(actions)
        if index > conditional_index
        and action["WFWorkflowActionIdentifier"] == "is.workflow.actions.conditional"
        and action["WFWorkflowActionParameters"].get("WFControlFlowMode") == 1
    )
    assert conditional_index < success_index < otherwise_index
    assert any(
        action["WFWorkflowActionIdentifier"] == "is.workflow.actions.getvalueforkey"
        and action["WFWorkflowActionParameters"].get("WFDictionaryKey") == "error_code"
        for action in actions[otherwise_index + 1:]
    )


def test_receipt_shortcut_stops_before_scanning_without_a_web_handoff() -> None:
    with SHORTCUT.open("rb") as source:
        workflow = plistlib.load(source)

    actions = workflow["WFWorkflowActions"]
    photo_index = next(
        index for index, action in enumerate(actions)
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.selectphoto"
    )
    guarded_outputs = {
        "11000000-0000-4000-8000-000000000002",
        "11000000-0000-4000-8000-000000000003",
    }
    guarded = set()
    handoff_index = max(
        index for index, action in enumerate(actions)
        if action["WFWorkflowActionParameters"].get("UUID") in guarded_outputs
    )
    for index, action in enumerate(actions[:photo_index]):
        parameters = action["WFWorkflowActionParameters"]
        if (action["WFWorkflowActionIdentifier"] == "is.workflow.actions.conditional"
                and parameters.get("WFControlFlowMode") == 0
                and parameters.get("WFCondition") == 100):
            guarded.add(parameters["WFInput"]["Variable"]["Value"]["OutputUUID"])
            assert index > handoff_index
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.exit":
            assert index < photo_index

    assert guarded_outputs <= guarded
    assert sum(
        action["WFWorkflowActionIdentifier"] == "is.workflow.actions.exit"
        for action in actions[:photo_index]
    ) >= 2
