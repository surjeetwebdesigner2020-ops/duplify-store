interface ConfirmDestructiveModalProps {
  id: string;
  heading: string;
  message: string;
  confirmLabel: string;
  triggerLabel: string;
  /** POST action URL for the confirm submit. */
  formAction: string;
  triggerVariant?: "primary" | "secondary" | "tertiary";
  disabled?: boolean;
}

import { useEffect } from "react";
import { useFetcher, useRevalidator } from "react-router";

// Polaris web components expose modal show/hide via command/commandFor.
// Confirm uses a hidden form + requestSubmit — associating via the HTML
// `form` attribute on s-button was unreliable and hid the primary action.
export function ConfirmDestructiveModal({
  id,
  heading,
  message,
  confirmLabel,
  triggerLabel,
  formAction,
  triggerVariant = "secondary",
  disabled = false,
}: ConfirmDestructiveModalProps) {
  const formId = `${id}-form`;
  const cancelButtonId = `${id}-cancel`;
  const fetcher = useFetcher<{ ok: boolean }>();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.ok) return;
    document.getElementById(cancelButtonId)?.click();
    revalidator.revalidate();
  }, [cancelButtonId, fetcher.data, fetcher.state, revalidator]);

  return (
    <>
      <s-button
        command="--show"
        commandFor={id}
        variant={triggerVariant}
        tone="critical"
        disabled={disabled}
      >
        {triggerLabel}
      </s-button>

      <fetcher.Form id={formId} method="post" action={formAction} hidden />

      <s-modal id={id} heading={heading}>
        <s-paragraph>{message}</s-paragraph>
        <s-button
          slot="primary-action"
          tone="critical"
          variant="primary"
          {...(fetcher.state !== "idle" ? { loading: true } : {})}
          onClick={() => {
            const form = document.getElementById(
              formId,
            ) as HTMLFormElement | null;
            form?.requestSubmit();
          }}
        >
          {confirmLabel}
        </s-button>
        <s-button
          id={cancelButtonId}
          slot="secondary-actions"
          command="--hide"
          commandFor={id}
        >
          Cancel
        </s-button>
      </s-modal>
    </>
  );
}
