# Apple receipt model comparison feasibility

Date: 2026-11-08

## Result

The comparison is feasible as an explicit benchmark, with one important limitation: Apple documents image analysis for Private Cloud Compute and extension models, but not for the On-Device model. The On-Device route therefore receives the same recognized text and photo attachment but must be judged primarily as a text-model route. The Private Cloud Compute route can use both the recognized text and the original photo.

This is an intentional end-to-end comparison of the two Apple routes, not a claim that both routes have identical image capabilities.

## Physical iPhone probe

The disposable `FinTracka Receipt Model Probe` ran on the household iPhone with these exact Shortcuts settings:

- action: **Use Model**
- model selectors: **On-Device** and **Cloud**
- output: **Text**
- Follow Up: off
- broad world knowledge/web search: off

Both actions executed sequentially. The Cloud route returned JSON-shaped output. The On-Device route returned a bounded refusal for an image whose details were not visible enough. No receipt content, photo, screenshot, or amount was committed to this repository.

## Gate status

| Check | Status | Notes |
|---|---|---|
| Model routes can be pinned | PASS | The selectors are explicit and were inspected on the iPhone. |
| Both routes accept the fixed request | PASS | Both actions execute with the same prompt and attachments. |
| On-Device photo analysis | LIMITED | Not guaranteed by Apple; recognized text is its reliable evidence input. |
| Private Cloud Compute photo analysis | PASS | Apple explicitly supports image analysis for this route. |
| Bounded output | PASS | Both routes are requested as Text and the Worker applies strict size/schema validation. |
| Offline/unavailable route behavior | STAGED | The comparison feature remains off by default until the private receipt run records this behavior. |

## Safety decision

The production receipt scanner remains version 2 while the comparison flag is off. Version 3 is used only for the temporary private benchmark. A model response is never trusted directly: FinTracka requires exact recognized-text evidence, integer cents, unique line evidence, and arithmetic consistency before a result can become an editable draft.

If either model action aborts the Shortcut instead of returning a result, that scan is recorded as an unavailable-route test and comparison mode stays disabled until the workflow can preserve the successful route safely.
