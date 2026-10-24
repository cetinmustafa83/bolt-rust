import type { LoaderFunctionArgs } from 'react-router';

export async function clientLoader(args: LoaderFunctionArgs) {
  return Response.json({ id: args.params.id });
}

export default function ChatRoute() {
  return null;
}
