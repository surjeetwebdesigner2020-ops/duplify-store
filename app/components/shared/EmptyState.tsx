interface EmptyStateAction {
  label: string;
  href: string;
  target?: "_blank" | "_self";
}

interface EmptyStateProps {
  heading: string;
  message: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
}

function linkTarget(action: EmptyStateAction) {
  return action.target ?? (/^https?:\/\//i.test(action.href) ? "_blank" : undefined);
}

// Official Shopify Polaris empty-state pattern (illustration + heading +
// paragraph + action group), built from native s-* components so it matches
// the rest of Shopify admin exactly. Callers already wrap this in their own
// <s-section heading="...">, so this renders just the pattern's inner content
// rather than another <s-section> (Polaris sections shouldn't nest).
export function EmptyState({ heading, message, action, secondaryAction }: EmptyStateProps) {
  return (
    <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
      <s-box maxInlineSize="360px" maxBlockSize="360px">
        <s-image
          aspectRatio="1/0.5"
          src="https://cdn.shopify.com/static/images/polaris/patterns/callout.png"
          alt=""
        />
      </s-box>
      <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
        <s-stack alignItems="center">
          <s-heading>{heading}</s-heading>
          <s-paragraph>{message}</s-paragraph>
        </s-stack>
        {(action || secondaryAction) && (
          <s-button-group>
            {secondaryAction && (
              <s-button
                slot="secondary-actions"
                href={secondaryAction.href}
                target={linkTarget(secondaryAction)}
              >
                {secondaryAction.label}
              </s-button>
            )}
            {action && (
              <s-button
                slot="primary-action"
                href={action.href}
                target={linkTarget(action)}
                variant="primary"
              >
                {action.label}
              </s-button>
            )}
          </s-button-group>
        )}
      </s-grid>
    </s-grid>
  );
}
