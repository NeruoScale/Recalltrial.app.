import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { ExternalLink, X, Calendar, DollarSign } from "lucide-react";
import type { Trial } from "@shared/schema";
import { useLocation } from "wouter";
import { format, differenceInDays, parseISO } from "date-fns";

function getDaysLeft(endDate: string) {
  const end = parseISO(endDate);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return differenceInDays(end, now);
}

function getStatusBadge(daysLeft: number, status: string) {
  if (status === "CANCELED") {
    return <Badge variant="secondary">Canceled</Badge>;
  }
  if (daysLeft < 0) {
    return <Badge variant="destructive">Expired</Badge>;
  }
  if (daysLeft <= 3) {
    return <Badge variant="destructive">Ends in {daysLeft}d</Badge>;
  }
  return <Badge variant="secondary">{daysLeft}d left</Badge>;
}

export function TrialCard({
  trial,
  onCancel,
}: {
  trial: Trial;
  onCancel: (id: string) => void;
}) {
  const [, setLocation] = useLocation();
  const daysLeft = getDaysLeft(trial.endDate);
  const cancelLink = trial.cancelUrl || trial.serviceUrl;
  const initial = trial.serviceName.charAt(0).toUpperCase();

  return (
    <Card className="hover-elevate cursor-pointer" data-testid={`card-trial-${trial.id}`}>
      <CardContent className="flex items-center gap-4 py-4">
        <Avatar className="h-10 w-10 shrink-0" onClick={() => setLocation(`/trials/${trial.id}`)}>
          {trial.iconUrl ? (
            <AvatarImage src={trial.iconUrl} alt={trial.serviceName} />
          ) : null}
          <AvatarFallback className="bg-primary/10 text-primary text-sm font-bold">
            {initial}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0" onClick={() => setLocation(`/trials/${trial.id}`)}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold truncate" data-testid={`text-name-${trial.id}`}>
              {trial.serviceName}
            </span>
            {getStatusBadge(daysLeft, trial.status)}
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground mt-0.5 flex-wrap">
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              Ends {format(parseISO(trial.endDate), "MMM d, yyyy")}
            </span>
            {trial.renewalPrice && (
              <span className="flex items-center gap-1">
                <DollarSign className="h-3.5 w-3.5" />
                {trial.renewalPrice} {trial.currency}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {trial.status === "ACTIVE" && (
            <>
              <Button
                size="icon"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(cancelLink, "_blank");
                }}
                title="Open cancel page"
                data-testid={`button-open-cancel-${trial.id}`}
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel(trial.id);
                }}
                title="Mark as canceled"
                data-testid={`button-cancel-${trial.id}`}
              >
                <X className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
