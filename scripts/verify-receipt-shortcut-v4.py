#!/usr/bin/env python3
"""Fail closed unless the canonical receipt Shortcut matches the v4 contract."""

from __future__ import annotations

import plistlib
import hashlib
import json
import re
import sys
from pathlib import Path


FORBIDDEN_IDENTIFIERS = {
    "is.workflow.actions.downloadurl",
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


def die(message: str) -> None:
    raise SystemExit(f"receipt shortcut v4 invalid: {message}")


def flatten(value: object) -> str:
    if isinstance(value, dict):
        return "\n".join(f"{key}\n{flatten(item)}" for key, item in value.items())
    if isinstance(value, list):
        return "\n".join(flatten(item) for item in value)
    return str(value)


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
    forbidden = sorted(set(identifiers) & FORBIDDEN_IDENTIFIERS)
    if forbidden:
        die(f"forbidden actions: {', '.join(forbidden)}")
    all_text = flatten(workflow)
    if re.search(r"https?://|x-callback|clipboard|bearer|authorization", all_text, re.I):
        die("URL, callback, clipboard, or persistent credential text is present")

    if identifiers[:2] != ["is.workflow.actions.comment", "is.workflow.actions.comment"]:
        die("the two required Shortcuts Playground comments must come first")
    for required in (
        "is.workflow.actions.choosefrommenu",
        "is.workflow.actions.takephoto",
        "is.workflow.actions.selectphoto",
        "is.workflow.actions.repeat.each",
        "is.workflow.actions.extracttextfromimage",
        "is.workflow.actions.image.convert",
        "is.workflow.actions.askllm",
        "is.workflow.actions.documentpicker.save",
    ):
        if required not in identifiers:
            die(f"missing action {required}")

    model_actions = [
        action.get("WFWorkflowActionParameters", {})
        for action in actions
        if action.get("WFWorkflowActionIdentifier") == "is.workflow.actions.askllm"
    ]
    if [action.get("WFLLMModel") for action in model_actions] != [
        "Apple Intelligence on Device",
        "Private Cloud Compute",
    ]:
        die("exactly two fixed Apple model routes are required")

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

    uuids = []
    for action in actions:
        value = action.get("WFWorkflowActionParameters", {}).get("UUID")
        if value:
            uuids.append(value)
    if len(uuids) != len(set(uuids)):
        die("action UUIDs are not unique")
    if any(value.startswith(("11000000-", "A1000000-")) for value in uuids):
        die("placeholder action UUID remains")

    questions = workflow.get("WFWorkflowImportQuestions", [])
    if len(questions) != 1 or questions[0].get("ParameterKey") != "WFFolder":
        die("install must ask once for the private shared iCloud folder")
    if questions[0].get("ActionIndex") != folder_indices[0]:
        die("install folder question does not target the create-folder action")

    if path.name == "FinTracka Receipt Scanner.plist":
        signed = path.with_suffix(".shortcut")
        provenance = path.with_suffix(".sha256.json")
        if not signed.is_file() or not provenance.is_file():
            die("signed artifact or provenance is missing")
        try:
            recorded = json.loads(provenance.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise SystemExit("receipt shortcut v4 invalid: signed provenance is invalid") from error
        expected = {
            "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "signed_sha256": hashlib.sha256(signed.read_bytes()).hexdigest(),
        }
        if recorded != expected or not signed.read_bytes().startswith(b"AEA1"):
            die("signed artifact does not match the verified source provenance")
    print(f"receipt shortcut v4 verified: {len(actions)} actions")


if __name__ == "__main__":
    main()
