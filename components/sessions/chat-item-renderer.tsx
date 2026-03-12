"use client";

import type { ChatItem } from "@/lib/sandbox-agent/event-types";
import { UserMessage } from "./user-message";
import { AgentMessage } from "./agent-message";
import { ThinkingBlock } from "./thinking-block";
import { ToolCallItem } from "./tool-call-item";
import { PermissionRequest } from "./permission-request";
import { QuestionRequest } from "./question-request";
import { ErrorItem } from "./error-item";
import { UsageItem, StatusItem, SessionEndedItem } from "./session-status";

interface ChatItemRendererProps {
  item: ChatItem;
}

export function ChatItemRenderer({ item }: ChatItemRendererProps) {
  switch (item.type) {
    case "user_prompt":
      return <UserMessage text={item.text} />;
    case "agent_message":
      return <AgentMessage text={item.text} />;
    case "agent_thought":
      return <ThinkingBlock text={item.text} />;
    case "tool_call":
      return (
        <ToolCallItem
          toolName={item.toolName}
          title={item.title}
          status={item.status}
          locations={item.locations}
          content={item.content}
        />
      );
    case "usage":
      return <UsageItem cost={item.cost} used={item.used} size={item.size} />;
    case "status":
      return <StatusItem label={item.label} detail={item.detail} />;
    case "permission_request":
      return (
        <PermissionRequest
          permissionId={item.permissionId}
          action={item.action}
          status={item.status}
        />
      );
    case "question_request":
      return (
        <QuestionRequest
          questionId={item.questionId}
          prompt={item.prompt}
          options={item.options}
          status={item.status}
          response={item.response}
        />
      );
    case "error":
      return <ErrorItem message={item.message} code={item.code} />;
    case "session_ended":
      return <SessionEndedItem reason={item.reason} message={item.message} />;
    default:
      return null;
  }
}
