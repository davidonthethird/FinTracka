from __future__ import annotations

import json
import plistlib
from pathlib import Path


SHORTCUT = Path(__file__).parents[1] / "shortcuts" / "FinTracka Receipt Model Comparison.xml"
PHOTO_UUID = "11000000-0000-4000-8000-000000000004"
RAW_OCR_UUID = "11000000-0000-4000-8000-000000000005"
RAW_ON_DEVICE_UUID = "11000000-0000-4000-8000-000000000006"
RAW_CLOUD_UUID = "11000000-0000-4000-8000-000000000007"
PLAIN_TEXT_UUIDS = {
    "text": "11000000-0000-4000-8000-000000000028",
    "on_device_model_result": "11000000-0000-4000-8000-000000000029",
    "private_cloud_compute_model_result": "11000000-0000-4000-8000-000000000030",
}
SNAPSHOT_UUIDS = {
    PLAIN_TEXT_UUIDS["text"]: "11000000-0000-4000-8000-000000000019",
    PLAIN_TEXT_UUIDS["on_device_model_result"]: "11000000-0000-4000-8000-000000000020",
    PLAIN_TEXT_UUIDS["private_cloud_compute_model_result"]: "11000000-0000-4000-8000-000000000021",
}


def test_receipt_ocr_reads_the_selected_photos() -> None:
    with SHORTCUT.open("rb") as source:
        workflow = plistlib.load(source)

    extract = next(
        action for action in workflow["WFWorkflowActions"]
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.extracttextfromimage"
    )
    parameters = extract["WFWorkflowActionParameters"]
    assert "imageFile" not in parameters
    assert parameters["WFImage"]["Value"] == {
        "OutputUUID": PHOTO_UUID,
        "OutputName": "Photos",
        "Type": "ActionOutput",
    }


def test_receipt_upload_contains_only_plain_text_snapshots() -> None:
    with SHORTCUT.open("rb") as source:
        workflow = plistlib.load(source)

    actions = workflow["WFWorkflowActions"]
    upload = next(
        action for action in actions
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.downloadurl"
    )
    parameters = upload["WFWorkflowActionParameters"]
    assert parameters["WFHTTPBodyType"] == "File"
    assert "WFJSONValues" not in parameters
    body_uuid = parameters["WFRequestVariable"]["Value"]["OutputUUID"]
    body_action = next(
        action for action in actions
        if action["WFWorkflowActionParameters"].get("UUID") == body_uuid
    )
    assert body_action["WFWorkflowActionIdentifier"] == "is.workflow.actions.gettext"
    body = body_action["WFWorkflowActionParameters"]["WFTextActionText"]
    body_template = body["Value"]["string"]
    assert '"payload_encoding":"percent"' in body_template
    assert '"shortcut_version":3' in body_template
    body_outputs = {
        attachment["OutputUUID"]
        for attachment in body["Value"]["attachmentsByRange"].values()
    }
    assert set(PLAIN_TEXT_UUIDS.values()) <= body_outputs

    rendered = body_template
    replacements = {
        61: "a" * 64,
        122: "ACME%20MARKETS%0ATOTAL%206.35",
        181: "1234",
        210: "%7B%22merchant%22%3A%22ACME%22%7D",
        293: "2345",
        334: "%7B%22merchant%22%3A%22ACME%22%7D",
    }
    for position in sorted(replacements, reverse=True):
        assert rendered[position] == "￼"
        rendered = rendered[:position] + replacements[position] + rendered[position + 1:]
    assert json.loads(rendered) == {
        "contract": "receipt_shortcut_capture/v3",
        "idempotency_key": "a" * 64,
        "shortcut_version": 3,
        "payload_encoding": "percent",
        "text": "ACME%20MARKETS%0ATOTAL%206.35",
        "on_device_status": "completed",
        "on_device_duration_ms": "1234",
        "on_device_model_result": "%7B%22merchant%22%3A%22ACME%22%7D",
        "private_cloud_compute_status": "completed",
        "private_cloud_compute_duration_ms": "2345",
        "private_cloud_compute_model_result": "%7B%22merchant%22%3A%22ACME%22%7D",
    }

    serialized_upload = plistlib.dumps(upload)
    for forbidden_uuid in (PHOTO_UUID, RAW_OCR_UUID, RAW_ON_DEVICE_UUID, RAW_CLOUD_UUID):
        assert forbidden_uuid.encode() not in serialized_upload

    encoded_text_actions = {
        action["WFWorkflowActionParameters"].get("UUID"): action
        for action in actions
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.urlencode"
    }
    assert set(PLAIN_TEXT_UUIDS.values()) <= encoded_text_actions.keys()
    for encoded_uuid, snapshot_uuid in SNAPSHOT_UUIDS.items():
        encoded_input = encoded_text_actions[encoded_uuid]["WFWorkflowActionParameters"]["WFInput"]["Value"]
        assert encoded_input["OutputUUID"] == snapshot_uuid
        assert encoded_input["OutputName"] == "Text"

    assert not any(
        action["WFWorkflowActionIdentifier"] in {
            "is.workflow.actions.text.match",
            "is.workflow.actions.text.combine",
        }
        for action in actions
    )

    idempotency_source = next(
        action for action in actions
        if action["WFWorkflowActionParameters"].get("CustomOutputName") == "Idempotency Source"
    )
    idempotency_attachments = idempotency_source["WFWorkflowActionParameters"]["WFTextActionText"]["Value"]["attachmentsByRange"]
    recognized_text = idempotency_attachments["{2, 1}"]
    assert recognized_text["OutputUUID"] == SNAPSHOT_UUIDS[PLAIN_TEXT_UUIDS["text"]]
    assert recognized_text["OutputName"] == "Text"


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
