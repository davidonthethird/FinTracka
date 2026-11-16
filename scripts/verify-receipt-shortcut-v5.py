#!/usr/bin/env python3
"""Fail closed unless the canonical receipt Shortcut matches the v5 contract."""

from __future__ import annotations

import plistlib
import re
import sys
from pathlib import Path


FORBIDDEN_IDENTIFIERS = {
    "is.workflow.actions.openurl",
    "is.workflow.actions.openxcallbackurl",
    "is.workflow.actions.getclipboard",
    "is.workflow.actions.setclipboard",
    "is.workflow.actions.runjavascriptforwebpage",
    "is.workflow.actions.runscript",
    "is.workflow.actions.runsshscript",
}
REQUIRED_FILES = (
    "ocr.txt",
    "on-device.txt",
    "private-cloud-compute.txt",
    "manifest.txt",
)
EXPECTED_IDENTIFIERS = (
    "is.workflow.actions.comment", "is.workflow.actions.comment", "is.workflow.actions.comment",
    "is.workflow.actions.text.match", "is.workflow.actions.count", "is.workflow.actions.comment",
    "is.workflow.actions.conditional", "is.workflow.actions.conditional",
    "is.workflow.actions.showresult", "is.workflow.actions.exit",
    "is.workflow.actions.conditional", "is.workflow.actions.text.split",
    "is.workflow.actions.getitemfromlist", "is.workflow.actions.getitemfromlist",
    "is.workflow.actions.comment",
    "is.workflow.actions.choosefrommenu", "is.workflow.actions.choosefrommenu",
    "is.workflow.actions.ask", "is.workflow.actions.takephoto", "is.workflow.actions.setvariable",
    "is.workflow.actions.choosefrommenu", "is.workflow.actions.selectphoto",
    "is.workflow.actions.setvariable", "is.workflow.actions.choosefrommenu",
    "is.workflow.actions.getvariable", "is.workflow.actions.count", "is.workflow.actions.number",
    "is.workflow.actions.comment", "is.workflow.actions.conditional",
    "is.workflow.actions.conditional", "is.workflow.actions.showresult", "is.workflow.actions.exit",
    "is.workflow.actions.conditional", "is.workflow.actions.file.createfolder",
    "is.workflow.actions.comment", "is.workflow.actions.repeat.each",
    "is.workflow.actions.image.convert", "is.workflow.actions.comment",
    "is.workflow.actions.conditional", "is.workflow.actions.gettext",
    "is.workflow.actions.setvariable", "is.workflow.actions.conditional",
    "is.workflow.actions.gettext", "is.workflow.actions.setvariable",
    "is.workflow.actions.conditional", "is.workflow.actions.getvariable",
    "is.workflow.actions.setitemname", "is.workflow.actions.documentpicker.save",
    "is.workflow.actions.extracttextfromimage", "is.workflow.actions.gettext",
    "is.workflow.actions.appendvariable", "is.workflow.actions.repeat.each",
    "is.workflow.actions.getvariable", "is.workflow.actions.text.combine",
    "is.workflow.actions.setitemname", "is.workflow.actions.documentpicker.save",
    "is.workflow.actions.comment", "is.workflow.actions.comment", "is.workflow.actions.gettext",
    "is.workflow.actions.setitemname", "is.workflow.actions.documentpicker.save",
    "is.workflow.actions.date", "is.workflow.actions.askllm", "is.workflow.actions.date",
    "is.workflow.actions.gettimebetweendates", "is.workflow.actions.math",
    "is.workflow.actions.round", "is.workflow.actions.comment",
    "is.workflow.actions.setitemname", "is.workflow.actions.documentpicker.save",
    "is.workflow.actions.date", "is.workflow.actions.format.date",
    "is.workflow.actions.gettext", "is.workflow.actions.setitemname",
    "is.workflow.actions.documentpicker.save", "is.workflow.actions.comment",
    "is.workflow.actions.downloadurl", "is.workflow.actions.getvalueforkey",
    "is.workflow.actions.comment", "is.workflow.actions.conditional",
    "is.workflow.actions.showresult", "is.workflow.actions.conditional",
    "is.workflow.actions.showresult", "is.workflow.actions.conditional",
)
REQUIRED_PARAMETERS = {
    "is.workflow.actions.comment": ("WFCommentActionText",),
    "is.workflow.actions.text.match": ("text", "WFMatchTextPattern", "WFMatchTextCaseSensitive"),
    "is.workflow.actions.count": ("WFInput", "WFCountType"),
    "is.workflow.actions.showresult": ("Text",),
    "is.workflow.actions.text.split": ("text", "WFTextSeparator"),
    "is.workflow.actions.getitemfromlist": ("WFInput", "WFItemIndex", "WFItemSpecifier"),
    "is.workflow.actions.ask": ("WFAskActionPrompt", "WFInputType"),
    "is.workflow.actions.takephoto": ("WFPhotoCount",),
    "is.workflow.actions.setvariable": ("WFInput", "WFVariableName"),
    "is.workflow.actions.selectphoto": ("WFSelectMultiplePhotos", "WFPhotoPickerTypes"),
    "is.workflow.actions.getvariable": ("WFVariable",),
    "is.workflow.actions.number": ("WFNumberActionNumber",),
    "is.workflow.actions.file.createfolder": ("WFFilePath",),
    "is.workflow.actions.image.convert": ("WFInput", "WFImageFormat"),
    "is.workflow.actions.gettext": ("WFTextActionText",),
    "is.workflow.actions.setitemname": ("WFInput", "WFName"),
    "is.workflow.actions.documentpicker.save": ("WFInput", "WFFolder", "WFAskWhereToSave"),
    "is.workflow.actions.extracttextfromimage": ("WFImage",),
    "is.workflow.actions.appendvariable": ("WFInput", "WFVariableName"),
    "is.workflow.actions.text.combine": ("text", "WFTextSeparator"),
    "is.workflow.actions.date": ("WFDateActionMode",),
    "is.workflow.actions.askllm": ("WFLLMModel", "WFLLMPrompt", "WFGenerativeResultType"),
    "is.workflow.actions.gettimebetweendates": ("WFInput", "WFTimeUntilFromDate", "WFTimeUntilUnit"),
    "is.workflow.actions.math": ("WFInput", "WFMathOperation", "WFMathOperand"),
    "is.workflow.actions.round": ("WFInput", "WFRoundMode", "WFRoundTo"),
    "is.workflow.actions.format.date": ("WFDate", "WFDateFormatStyle"),
    "is.workflow.actions.downloadurl": (
        "WFURL", "WFHTTPMethod", "WFHTTPBodyType", "WFHTTPHeaders", "WFJSONValues",
    ),
    "is.workflow.actions.getvalueforkey": (
        "WFInput", "WFDictionaryKey", "WFGetDictionaryValueType",
    ),
}


def die(message: str) -> None:
    raise SystemExit(f"receipt shortcut v5 invalid: {message}")


def flatten(value: object) -> str:
    if isinstance(value, dict):
        return "\n".join(f"{key}\n{flatten(item)}" for key, item in value.items())
    if isinstance(value, list):
        return "\n".join(flatten(item) for item in value)
    return str(value)


def walk(value: object, path: str = ""):
    yield path, value
    if isinstance(value, dict):
        for key, item in value.items():
            yield from walk(item, f"{path}.{key}" if path else key)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from walk(item, f"{path}[{index}]")


def validate_token_strings(value: object) -> None:
    for path, item in walk(value):
        if not isinstance(item, dict) or item.get("WFSerializationType") != "WFTextTokenString":
            continue
        data = item.get("Value")
        if not isinstance(data, dict) or not isinstance(data.get("string"), str):
            die(f"invalid token string at {path}")
        text = data["string"]
        attachments = data.get("attachmentsByRange")
        if not isinstance(attachments, dict):
            die(f"token string attachments missing at {path}")
        for span, attachment in attachments.items():
            match = re.fullmatch(r"\{(\d+), (\d+)\}", span)
            if not match or not isinstance(attachment, dict):
                die(f"invalid token attachment at {path}.{span}")
            start, length = map(int, match.groups())
            if length != 1 or text[start : start + length] != "\ufffc":
                die(f"token attachment offset is invalid at {path}.{span}")


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "shortcuts/FinTracka Receipt Scanner.plist")
    if not path.is_file():
        die(f"missing {path}")
    workflow = plistlib.loads(path.read_bytes())
    if workflow.get("WFWorkflowName") != "FinTracka Receipt Scanner":
        die("canonical name is not FinTracka Receipt Scanner")
    actions = workflow.get("WFWorkflowActions")
    if not isinstance(actions, list) or not actions:
        die("action list is empty")

    identifiers = [action.get("WFWorkflowActionIdentifier") for action in actions]
    if tuple(identifiers) != EXPECTED_IDENTIFIERS:
        die("the exact reviewed 84-action inventory changed")
    forbidden = sorted(set(identifiers) & FORBIDDEN_IDENTIFIERS)
    if forbidden:
        die(f"forbidden actions: {', '.join(forbidden)}")
    all_text = flatten(workflow)
    endpoint = (
        "https://fintracka-viewer-production.fintracka-david.workers.dev/"
        "api/v1/mobile/shortcut/receipt-imports"
    )
    urls = re.findall(r"https?://[^\s<]+", all_text, re.I)
    if urls != [endpoint]:
        die("the exact one fixed upload endpoint is required")
    if re.search(r"x-callback|clipboard|CF-Access|service.?token|api.?key", all_text, re.I):
        die("callback, clipboard, Access credential, service token, or API key text is present")

    if "is.workflow.actions.nothing" in identifiers or re.search(
        r"Empty Model Result|File Text", all_text, re.I
    ):
        die("an unreviewed empty model-result fallback remains")

    action_positions: dict[str, int] = {}
    for index, action in enumerate(actions):
        parameters = action.get("WFWorkflowActionParameters")
        if not isinstance(parameters, dict):
            die(f"action {index} has no parameters dictionary")
        uuid = parameters.get("UUID")
        if not isinstance(uuid, str) or not uuid:
            die(f"action {index} has no UUID")
        if uuid in action_positions:
            die("action UUIDs are not unique")
        action_positions[uuid] = index
        for key in REQUIRED_PARAMETERS.get(action["WFWorkflowActionIdentifier"], ()):
            if key not in parameters:
                die(f"action {index} is missing required parameter {key}")
        mode = parameters.get("WFControlFlowMode")
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.conditional" and mode == 0:
            keys = ("WFCondition", "WFInput") if parameters.get("WFCondition") == 100 \
                else ("WFCondition", "WFInput", "WFNumberValue")
            for key in keys:
                if key not in parameters:
                    die(f"conditional action {index} is missing {key}")
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.choosefrommenu":
            if mode == 0 and not {"WFMenuItems", "WFMenuPrompt"} <= parameters.keys():
                die(f"menu action {index} is missing its items or prompt")
            if mode == 1 and "WFMenuItemTitle" not in parameters:
                die(f"menu branch {index} is missing its title")
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.repeat.each" and \
                mode == 0 and "WFInput" not in parameters:
            die(f"repeat action {index} is missing its input")
        for path, value in walk(parameters, f"actions[{index}]"):
            if value in (None, "", [], {}):
                if path.endswith(".attachmentsByRange") and value == {}:
                    continue
                die(f"empty action parameter at {path}")
    validate_token_strings(workflow)

    for path, value in walk(actions):
        if not isinstance(value, dict) or value.get("Type") != "ActionOutput":
            continue
        output_uuid = value.get("OutputUUID")
        output_name = value.get("OutputName")
        if not isinstance(output_uuid, str) or not isinstance(output_name, str) or not output_name:
            die(f"invalid action output reference at {path}")
        reference_index = int(path.split("[", 1)[1].split("]", 1)[0])
        if output_uuid not in action_positions or action_positions[output_uuid] >= reference_index:
            die(f"action output reference is missing or not earlier at {path}")

    groups: dict[tuple[str, str], list[int]] = {}
    for index, action in enumerate(actions):
        parameters = action["WFWorkflowActionParameters"]
        group = parameters.get("GroupingIdentifier")
        mode = parameters.get("WFControlFlowMode")
        if group is None:
            continue
        groups.setdefault((action["WFWorkflowActionIdentifier"], group), []).append(mode)
        if mode == 0 and (index == 0 or identifiers[index - 1] != "is.workflow.actions.comment"):
            die(f"control-flow group at action {index} lacks its wiring comment")
    for (identifier, _), modes in groups.items():
        if modes[0] != 0 or modes[-1] != 2 or any(mode not in (0, 1, 2) for mode in modes):
            die(f"incomplete {identifier} control-flow group")

    model_actions = [
        action.get("WFWorkflowActionParameters", {})
        for action in actions
        if action.get("WFWorkflowActionIdentifier") == "is.workflow.actions.askllm"
    ]
    if [action.get("WFLLMModel") for action in model_actions] != ["Cloud Pro"]:
        die("exactly one fixed Cloud Pro model route is required")
    model_indices = [index for index, identifier in enumerate(identifiers)
                     if identifier == "is.workflow.actions.askllm"]
    model_index = model_indices[0]
    if identifiers[model_index + 5 : model_index + 7] != [
        "is.workflow.actions.comment", "is.workflow.actions.setitemname"
    ] or "private-cloud-compute.txt" not in flatten(actions[model_index + 6 : model_index + 8]):
        die("private-cloud-compute.txt is not saved directly from Cloud Pro")
    if "on-device.txt" not in flatten(actions[model_index - 5 : model_index]):
        die("the unavailable on-device compatibility file is missing before Cloud Pro")

    uploads = [
        (index, action["WFWorkflowActionParameters"])
        for index, action in enumerate(actions)
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.downloadurl"
    ]
    if len(uploads) != 1:
        die("exactly one direct upload is required")
    upload_index, upload = uploads[0]
    if upload.get("WFHTTPMethod") != "POST" or upload.get("WFHTTPBodyType") != "JSON":
        die("direct upload must be a JSON POST")
    if endpoint not in flatten(upload.get("WFURL")):
        die("direct upload does not use the fixed production endpoint")
    header_text = flatten(upload.get("WFHTTPHeaders"))
    if "Authorization" not in header_text or "Bearer " not in header_text \
            or "Content-Type" not in header_text or "application/json" not in header_text:
        die("direct upload headers are incomplete")
    body_text = flatten(upload.get("WFJSONValues"))
    for key in ("contract", "receipt_shortcut_capture/v2", "idempotency_key",
                "shortcut_version", "text", "model_result"):
        if key not in body_text:
            die(f"direct upload JSON is missing {key}")
    item_actions = [
        action["WFWorkflowActionParameters"]
        for action in actions
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.getitemfromlist"
    ]
    handoff_action = next(item for item in item_actions if item.get("WFItemIndex") == 2)
    token_action = next(item for item in item_actions if item.get("WFItemIndex") == 3)
    combined_action = next(
        action["WFWorkflowActionParameters"] for action in actions
        if action["WFWorkflowActionIdentifier"] == "is.workflow.actions.text.combine"
    )
    model_action = model_actions[0]
    if token_action["UUID"] not in header_text or handoff_action["UUID"] not in body_text \
            or combined_action["UUID"] not in body_text or model_action["UUID"] not in body_text:
        die("direct upload does not derive from the validated token and saved capture outputs")

    if all_text.count("Repeat Item") < 2 or "Repeat Index" not in all_text:
        die("per-page OCR and page serialization must use Repeat Item/Repeat Index")
    if "--- PAGE " not in all_text:
        die("explicit OCR page markers are missing")
    if "WFSelectMultiplePhotos" not in all_text or "WFPhotoCount" not in all_text:
        die("camera and multi-photo-library inputs are not bounded")
    folder_indices = [index for index, identifier in enumerate(identifiers)
                      if identifier == "is.workflow.actions.file.createfolder"]
    page_input_indices = [index for index, identifier in enumerate(identifiers)
                          if identifier in {"is.workflow.actions.takephoto",
                                            "is.workflow.actions.selectphoto",
                                            "is.workflow.actions.count"}]
    if len(folder_indices) != 1 or folder_indices[0] <= max(page_input_indices):
        die("receipt package folder must be created only after valid page selection")

    saves = [
        (index, flatten(actions[max(0, index - 1) : index + 1]))
        for index, action in enumerate(actions)
        if action.get("WFWorkflowActionIdentifier") == "is.workflow.actions.documentpicker.save"
    ]
    for filename in REQUIRED_FILES:
        matches = [index for index, text in saves if filename in text]
        if len(matches) != 1:
            die(f"{filename} must be saved exactly once")
    manifest_index = next(index for index, text in saves if "manifest.txt" in text)
    if manifest_index != max(index for index, _ in saves):
        die("manifest.txt must be the final save")
    if upload_index <= manifest_index:
        die("direct upload must occur only after manifest.txt is saved")
    if not re.search(r"page-00.*\.heic", all_text) or not re.search(r"page-0.*\.heic", all_text):
        die("padded HEIC page filenames are missing")

    manifest_action_text = "\n".join(flatten(action) for action in actions[max(0, manifest_index - 4) : manifest_index + 1])
    for key in (
        "contract=receipt_queue_capture/v1",
        "handoff_id=",
        "page_count=",
        "created_at=",
        "on_device_status=",
        "on_device_duration_ms=",
        "private_cloud_compute_status=",
        "private_cloud_compute_duration_ms=",
    ):
        if key not in manifest_action_text:
            die(f"manifest key missing: {key}")
    if "On-Device Result" in manifest_action_text or "Private Cloud Compute Result" in manifest_action_text:
        die("free-form model output must not be interpolated into the manifest")
    if "on_device_status=unavailable" not in manifest_action_text or \
            "on_device_duration_ms=0" not in manifest_action_text or \
            "private_cloud_compute_status=completed" not in manifest_action_text:
        die("manifest must record unavailable on-device and completed Cloud Pro routes")

    uuids = list(action_positions)
    if any(value.startswith(("11000000-", "A1000000-")) for value in uuids):
        die("placeholder action UUID remains")

    questions = workflow.get("WFWorkflowImportQuestions", [])
    if len(questions) != 1 or questions[0].get("ParameterKey") != "WFFolder":
        die("install must ask once for the private shared iCloud folder")
    if questions[0].get("ActionIndex") != folder_indices[0]:
        die("install folder question does not target the create-folder action")

    print(f"receipt shortcut v5 verified: {len(actions)} actions")


if __name__ == "__main__":
    main()
