import { createQuery } from "react-query-kit";
import { listDirectories, type DirListing } from "../server/browse";
import { unwrapResult } from "../server/result";

// The picker navigates one directory at a time, so the query is keyed on the
// path being listed; navigating to a sibling lists a different key instead of
// serving a cached root listing. Omitted `path` (or "") lists the browse root.
export const useBrowse = createQuery<DirListing, { path?: string }>({
  queryKey: ["browse"],
  fetcher: (variables) => listDirectories({ data: variables }).then(unwrapResult),
});
