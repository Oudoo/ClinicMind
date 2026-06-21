import { AssistantChat } from "@/components/clinicmind/assistant-chat";
import { SectionTitle } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default function AssistantPage() {
  return (
    <div className="space-y-4">
      <SectionTitle
        title="AI Assistant"
        description="Retrieval-grounded clinical chat over your tenant's records."
      />
      <AssistantChat />
    </div>
  );
}
