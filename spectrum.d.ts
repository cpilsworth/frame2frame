// Spectrum Web Components are custom elements. Register their tag names with
// the JSX type-checker so home.tsx can render them. Attributes are loosely
// typed (custom elements take arbitrary attributes); the components' real
// behaviour is defined by the runtime bundle in src/client/app.ts.
import type * as React from "react";

type SpectrumProps = { children?: React.ReactNode; [attr: string]: unknown };

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "sp-theme": SpectrumProps;
      "sp-switch": SpectrumProps;
      "sp-action-button": SpectrumProps;
      "sp-button": SpectrumProps;
      "sp-dropzone": SpectrumProps;
      "sp-progress-bar": SpectrumProps;
      "sp-toast": SpectrumProps;
      "sp-accordion": SpectrumProps;
      "sp-accordion-item": SpectrumProps;
      "sp-avatar": SpectrumProps;
      "sp-field-label": SpectrumProps;
    }
  }
}
