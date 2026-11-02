import { isRouteErrorResponse, useRouteError } from 'react-router';
import { describeError } from '@/lib/api';
import { ErrorPanel } from './error-panel';
import { Page } from './page';

export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `The page answered with status ${error.status}.`
    : describeError(error);
  return (
    <Page>
      <ErrorPanel title="This page could not be shown" message={message} />
    </Page>
  );
}
