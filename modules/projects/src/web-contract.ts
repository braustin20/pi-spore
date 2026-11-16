import { defineInterface } from "@pi-spore/module-api";
import type { ComponentType } from "react";

/** A panel another web module adds to the Settings page, such as Role models (ADR 0181). */
export interface SettingsSection {
  id: string;
  /** Lower comes first. */
  order: number;
  component: ComponentType;
}

export interface SettingsPageView {
  addSection(section: SettingsSection): void;
}

export const SettingsPageKey = defineInterface<SettingsPageView>("projects", "settings-page");
