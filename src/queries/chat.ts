import { createMutation, createQuery } from "react-query-kit";
import {
  createChatSession,
  createTicketFromChat,
  draftSpecFromChat,
  getChatSession,
  sendChatMessage,
  type ChatSessionDTO,
  type ChatSessionRef,
  type CreateChatSessionInput,
  type SendChatMessageInput,
} from "../server/chat";
import { unwrapResult } from "../server/result";
import { isChatTurnPending } from "../components/chatUi";

const POLL_INTERVAL_MS = 1500;

export const useChatSession = createQuery<ChatSessionDTO, ChatSessionRef>({
  queryKey: ["chatSession"],
  fetcher: (variables) => getChatSession({ data: variables }).then(unwrapResult),
  refetchInterval: (query) =>
    query.state.data && isChatTurnPending(query.state.data.turnStatus)
      ? POLL_INTERVAL_MS
      : false,
});

export const useCreateChatSession = createMutation<
  { id: string },
  CreateChatSessionInput
>({
  mutationFn: (variables) =>
    createChatSession({ data: variables }).then(unwrapResult),
});

export const useSendChatMessage = createMutation<{ ok: true }, SendChatMessageInput>({
  mutationFn: (variables) =>
    sendChatMessage({ data: variables }).then(unwrapResult),
});

export const useDraftSpecFromChat = createMutation<{ ok: true }, ChatSessionRef>({
  mutationFn: (variables) =>
    draftSpecFromChat({ data: variables }).then(unwrapResult),
});

export const useCreateTicketFromChat = createMutation<
  { ticketId: string; seq: number },
  ChatSessionRef
>({
  mutationFn: (variables) =>
    createTicketFromChat({ data: variables }).then(unwrapResult),
});
