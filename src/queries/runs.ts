import { createMutation, createQuery } from "react-query-kit";
import {
  continueExecution,
  dispatch,
  listRuns,
  logTail,
  turnTail,
  type ContinueExecutionInput,
  type DispatchRunInput,
  type ListRunsInput,
  type LogTailVariables,
  type RunDTO,
  type TurnTailResult,
  type TurnTailVariables,
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

export const useTurnTail = createQuery<TurnTailResult, TurnTailVariables>({
  queryKey: ["turnTail"],
  fetcher: (variables) => turnTail({ data: variables }).then(unwrapResult),
});

export const useContinueExecution = createMutation<
  void,
  ContinueExecutionInput
>({
  mutationFn: (variables) =>
    continueExecution({ data: variables }).then(unwrapResult),
});
