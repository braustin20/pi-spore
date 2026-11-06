# 0008. Questions go up the chain as durable deliveries

- Status: Accepted
- Date: 2026-11-06
- Requirements: R3.5, R7.5, R7.6

## Context

Lane agents need answers without the user watching every lane, and without agents polling.

## Decision

A lane asks its coordinator with `ask_coordinator`. The coordinator answers from the spec or escalates to the
user's inbox. No lane-to-lane messages. Agents outside a run use `request_human_input`. The tool files the
question and ends the turn; the answer arrives later as a new message through a delivery row. Waiting never holds
a tool call open.

## Consequences

- A long wait survives restarts.
- The asking agent must write its question so it can resume from the answer alone.
