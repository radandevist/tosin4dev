import { createMutation, createQuery } from "react-query-kit";
import {
  dispatch,
  listRuns,
  logTail,
  type DispatchRunInput,
  type ListRunsInput,
  type LogTailVariables,
  type RunDTO,
} from "../server/runs";
import { unwrapResult } from "../server/result";

export const useRuns = createQuery<RunDTO[], ListRunsInput>({
  queryKey: ["runs"],
  fetcher: (variables) => listRuns({ data: variables }).then(unwrapResult),
});

export const useDispatch = createMutation<
  { runId: string },
  DispatchRunInput
>({
  mutationFn: (variables) => dispatch({ data: variables }).then(unwrapResult),
});

export const useLogTail = createQuery<{ text: string }, LogTailVariables>({
  queryKey: ["logTail"],
  fetcher: (variables) => logTail({ data: variables }).then(unwrapResult),
});
