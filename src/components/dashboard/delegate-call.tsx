'use client';

/**
 * Delegate A Call Component
 * Form to trigger outbound calls via webhook
 * Supports call templates for quick delegation
 */

import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Phone,
  Send,
  CheckCircle2,
  AlertCircle,
  Save,
  Loader2,
  Plus,
  Trash2,
  FileText,
} from 'lucide-react';

// Call template interface
export interface CallTemplate {
  id: string;
  user_id: string;
  name: string;
  goal: string | null;
  context: string | null;
  phone_number: string | null;
  created_at: string;
  updated_at: string;
}

interface DelegateCallProps {
  customAssistantName?: string;
  templates?: CallTemplate[];
  onTemplatesChange?: () => void;
}

export function DelegateCall({
  customAssistantName = 'your AI assistant',
  templates = [],
  onTemplatesChange,
}: DelegateCallProps) {
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [toNumber, setToNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  // Template state
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [showSaveTemplateDialog, setShowSaveTemplateDialog] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);

  // Apply selected template to form
  const handleTemplateSelect = (templateId: string) => {
    setSelectedTemplateId(templateId);

    if (templateId === '') {
      // Clear form when "New Call" is selected
      setGoal('');
      setContext('');
      setToNumber('');
      return;
    }

    const template = templates.find(t => t.id === templateId);
    if (template) {
      setGoal(template.goal || '');
      setContext(template.context || '');
      setToNumber(template.phone_number || '');
    }
  };

  // Save current form as new template
  const handleSaveAsTemplate = async () => {
    if (!newTemplateName.trim()) return;

    setSavingTemplate(true);
    try {
      const response = await fetch('/api/call-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newTemplateName.trim(),
          goal,
          context,
          phone_number: toNumber,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save template');
      }

      setShowSaveTemplateDialog(false);
      setNewTemplateName('');
      onTemplatesChange?.();
    } catch (error: any) {
      console.error('Error saving template:', error);
      alert(error.message || 'Failed to save template');
    } finally {
      setSavingTemplate(false);
    }
  };

  // Delete a template
  const handleDeleteTemplate = async (templateId: string, e: React.MouseEvent) => {
    e.stopPropagation();

    if (!confirm('Are you sure you want to delete this template?')) return;

    setDeletingTemplateId(templateId);
    try {
      const response = await fetch(`/api/call-templates/${templateId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete template');
      }

      // Clear selection if deleted template was selected
      if (selectedTemplateId === templateId) {
        setSelectedTemplateId('');
        setGoal('');
        setContext('');
        setToNumber('');
      }

      onTemplatesChange?.();
    } catch (error: any) {
      console.error('Error deleting template:', error);
      alert('Failed to delete template');
    } finally {
      setDeletingTemplateId(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStatus('idle');
    setMessage('');

    try {
      const response = await fetch('/api/delegate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal,
          context,
          to_number: toNumber,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Please sign in to delegate calls');
        }
        throw new Error(data.error || `Request failed: ${response.status}`);
      }

      setStatus('success');
      setMessage('Call delegated successfully!');
    } catch (error: any) {
      console.error('Error delegating call:', error);
      setStatus('error');
      setMessage(error.message || 'Failed to delegate call. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Phone className="h-6 w-6" />
        <h2 className="text-2xl font-bold">Assign a call to {customAssistantName}</h2>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Template Selector */}
            <div className="space-y-2">
              <Label htmlFor="template">Call Template</Label>
              <div className="flex gap-2">
                <Select value={selectedTemplateId} onValueChange={handleTemplateSelect}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Select a template or start fresh..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">
                      <div className="flex items-center gap-2">
                        <Plus className="h-4 w-4" />
                        New Call (blank)
                      </div>
                    </SelectItem>
                    {templates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        <div className="flex items-center justify-between w-full gap-2">
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4" />
                            <span>{template.name}</span>
                          </div>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowSaveTemplateDialog(true)}
                  title="Save as Template"
                >
                  <Save className="h-4 w-4" />
                </Button>
                {selectedTemplateId && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={(e) => handleDeleteTemplate(selectedTemplateId, e)}
                    disabled={deletingTemplateId === selectedTemplateId}
                    title="Delete Template"
                    className="text-destructive hover:text-destructive"
                  >
                    {deletingTemplateId === selectedTemplateId ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {templates.length > 0
                  ? `${templates.length} saved template${templates.length !== 1 ? 's' : ''}`
                  : 'No saved templates yet'}
              </p>
            </div>

            {/* End Goal Field */}
            <div className="space-y-2">
              <Label htmlFor="goal">
                End Goal <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="goal"
                placeholder="Describe the goal for this call..."
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                maxLength={250}
                required
                className="resize-none min-h-[100px]"
                style={{
                  height: 'auto',
                  minHeight: '100px',
                  maxHeight: '300px'
                }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = 'auto';
                  target.style.height = Math.min(target.scrollHeight, 300) + 'px';
                }}
              />
              <div className="flex justify-between">
                <p className="text-xs text-muted-foreground">
                  Describe the purpose and desired outcome of this call
                </p>
                <p className="text-xs text-muted-foreground">
                  {goal.length}/250
                </p>
              </div>
            </div>

            {/* Context Field */}
            <div className="space-y-2">
              <Label htmlFor="context">Context</Label>
              <Textarea
                id="context"
                placeholder="Provide additional context for this call..."
                value={context}
                onChange={(e) => setContext(e.target.value)}
                maxLength={500}
                className="resize-none min-h-[100px]"
                style={{
                  height: 'auto',
                  minHeight: '100px',
                  maxHeight: '300px'
                }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = 'auto';
                  target.style.height = Math.min(target.scrollHeight, 300) + 'px';
                }}
              />
              <div className="flex justify-between">
                <p className="text-xs text-muted-foreground">
                  Optional: Provide background information or specific details
                </p>
                <p className="text-xs text-muted-foreground">
                  {context.length}/500
                </p>
              </div>
            </div>

            {/* Number To Call Field */}
            <div className="space-y-2">
              <Label htmlFor="to_number">
                Number To Call <span className="text-destructive">*</span>
              </Label>
              <Input
                id="to_number"
                type="tel"
                placeholder="+1234567890"
                value={toNumber}
                onChange={(e) => setToNumber(e.target.value)}
                required
                pattern="^\+?[1-9]\d{1,14}$"
              />
              <p className="text-xs text-muted-foreground">
                Enter phone number in E.164 format (e.g., +14155551234)
              </p>
            </div>

            {/* Status Message */}
            {status !== 'idle' && (
              <div
                className={`flex items-center gap-2 p-3 rounded-md ${
                  status === 'success'
                    ? 'bg-green-50 text-green-900 dark:bg-green-900/10 dark:text-green-400'
                    : 'bg-red-50 text-red-900 dark:bg-red-900/10 dark:text-red-400'
                }`}
              >
                {status === 'success' ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <AlertCircle className="h-5 w-5" />
                )}
                <span className="text-sm font-medium">{message}</span>
              </div>
            )}

            {/* Submit Button */}
            <Button
              type="submit"
              className="w-full"
              disabled={loading || !goal || !toNumber}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Delegating...
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  Delegate Call
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Save Template Dialog */}
      <Dialog open={showSaveTemplateDialog} onOpenChange={setShowSaveTemplateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="template-name">Template Name</Label>
              <Input
                id="template-name"
                placeholder="e.g., Sam's Club Hours Check"
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value)}
                maxLength={100}
              />
            </div>
            <div className="text-sm text-muted-foreground space-y-1">
              <p>This will save:</p>
              <ul className="list-disc list-inside ml-2">
                <li>Goal: {goal || '(empty)'}</li>
                <li>Context: {context || '(empty)'}</li>
                <li>Phone: {toNumber || '(empty)'}</li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSaveTemplateDialog(false)}
              disabled={savingTemplate}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveAsTemplate}
              disabled={savingTemplate || !newTemplateName.trim()}
            >
              {savingTemplate ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save Template
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
