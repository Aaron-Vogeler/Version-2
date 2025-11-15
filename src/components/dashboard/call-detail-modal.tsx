'use client';

/**
 * Call Detail Modal
 * Shows comprehensive call information including transcript and audio playback
 */

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Phone,
  Clock,
  DollarSign,
  Target,
  CheckCircle2,
  XCircle,
  Play,
  Pause,
} from 'lucide-react';
import { formatPhoneNumber, formatDuration, formatCurrency, formatDateTime } from '@/lib/utils';
import { Call } from '@/lib/types/database';
import { LiveTranscript } from './live-transcript';

interface CallDetailModalProps {
  call: Call | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CallDetailModal({ call, open, onOpenChange }: CallDetailModalProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);

  const handlePlayPause = () => {
    if (!call?.recording_url) return;

    if (!audioElement) {
      const audio = new Audio(call.recording_url);
      audio.addEventListener('ended', () => setIsPlaying(false));
      setAudioElement(audio);
      audio.play();
      setIsPlaying(true);
    } else {
      if (isPlaying) {
        audioElement.pause();
      } else {
        audioElement.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  useEffect(() => {
    return () => {
      if (audioElement) {
        audioElement.pause();
        audioElement.remove();
      }
    };
  }, [audioElement]);

  if (!call) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="h-5 w-5" />
            Call Details
          </DialogTitle>
          <DialogDescription>
            {formatPhoneNumber(call.from_e164)} → {formatPhoneNumber(call.to_e164)}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="transcript">Transcript & Recording</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {/* Call Status */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Status</CardTitle>
                </CardHeader>
                <CardContent>
                  <Badge variant={call.status === 'completed' ? 'success' : 'warning'}>
                    {call.status.toUpperCase()}
                  </Badge>
                </CardContent>
              </Card>

              {/* Direction */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Direction</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <Phone className={`h-4 w-4 ${call.direction === 'inbound' ? 'rotate-180' : ''}`} />
                    <span className="capitalize">{call.direction}</span>
                  </div>
                </CardContent>
              </Card>

              {/* Duration */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Duration
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    <div className="text-2xl font-bold">
                      {formatDuration(call.duration_sec || 0)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Billable: {formatDuration(call.billable_sec || 0)}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Cost */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    Cost
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {formatCurrency(Number(call.cost_usd) || 0)}
                  </div>
                </CardContent>
              </Card>

              {/* Goal Status */}
              {call.goal && (
                <Card className="col-span-2">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Target className="h-4 w-4" />
                      Goal
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between">
                      <div>
                        <Badge className="mb-1">{call.goal}</Badge>
                        <div className="text-sm text-muted-foreground capitalize">
                          {call.goal_status || 'pending'}
                        </div>
                      </div>
                      {call.goal_status === 'achieved' ? (
                        <CheckCircle2 className="h-8 w-8 text-green-600" />
                      ) : call.goal_status === 'failed' ? (
                        <XCircle className="h-8 w-8 text-red-600" />
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Assistant Info */}
              {call.assistant_name && (
                <Card className="col-span-2">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-medium">AI Assistant</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{call.assistant_name}</div>
                        <div className="text-xs text-muted-foreground">
                          ID: {call.assistant_id}
                        </div>
                      </div>
                      {call.response_time_ms && (
                        <div className="text-right">
                          <div className="text-sm font-medium">
                            {(call.response_time_ms / 1000).toFixed(2)}s
                          </div>
                          <div className="text-xs text-muted-foreground">Response Time</div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Timestamps */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Timestamps</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Started:</span>
                  <span>{call.started_at ? formatDateTime(call.started_at) : '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Answered:</span>
                  <span>{call.answered_at ? formatDateTime(call.answered_at) : '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Ended:</span>
                  <span>{call.ended_at ? formatDateTime(call.ended_at) : '-'}</span>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Transcript & Recording Tab */}
          <TabsContent value="transcript" className="space-y-4">
            <LiveTranscript
              callId={call.id}
              initialTranscript={call.transcript}
              initialLiveTranscript={call.live_transcript}
              status={call.status}
            />

            {/* Link to external transcript if available */}
            {(call.transcript_url || call.transcription_url) && (
              <Card>
                <CardContent className="pt-6">
                  <div className="text-center">
                    <a
                      href={call.transcript_url || call.transcription_url || '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline text-sm"
                    >
                      View Full Transcript (External)
                    </a>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Audio Player */}
            {call.recording_url && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-medium">Recording</CardTitle>
                </CardHeader>
                <CardContent>
                  <Button
                    onClick={handlePlayPause}
                    variant="outline"
                    className="w-full"
                  >
                    {isPlaying ? (
                      <>
                        <Pause className="mr-2 h-4 w-4" />
                        Pause Recording
                      </>
                    ) : (
                      <>
                        <Play className="mr-2 h-4 w-4" />
                        Play Recording
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>
            )}
          </TabsContent>

        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
