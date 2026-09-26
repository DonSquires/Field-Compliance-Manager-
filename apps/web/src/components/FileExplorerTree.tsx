import { useEffect, useState } from 'react';
import { Building2, ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus } from 'lucide-react';
import './FileExplorerTree.css';

export interface FileExplorerSpace {
  id: string;
  space_key: string;
  name: string;
  sensitivity: 'internal' | 'restricted';
  sort_order: number;
  document_count: number;
}

export interface FileExplorerFolder {
  id: string;
  space_id: string;
  parent_folder_id: string | null;
  name: string;
  folder_kind: 'system' | 'entity' | 'custom';
  entity_type: 'location' | 'person_record' | 'user_profile' | null;
  entity_id: string | null;
  document_count: number;
}

export interface FileExplorerPlacement {
  document_id: string;
  space_id: string;
  folder_id: string | null;
}

export interface FileExplorerTreeData {
  organization: { id: string; name: string } | null;
  spaces: FileExplorerSpace[];
  folders: FileExplorerFolder[];
  placements: FileExplorerPlacement[];
}

interface FileExplorerTreeProps {
  tree: FileExplorerTreeData;
  selectedSpaceId: string | null;
  selectedFolderId: string | null;
  canCreateFolder: boolean;
  onSelect: (spaceId: string | null, folderId: string | null) => void;
  onCreateFolder: () => void;
}

function FolderNode({ folder, folders, selectedFolderId, expanded, onToggle, onSelect, depth }: {
  folder: FileExplorerFolder;
  folders: FileExplorerFolder[];
  selectedFolderId: string | null;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelect: (spaceId: string, folderId: string) => void;
  depth: number;
}) {
  const children = folders.filter((candidate) => candidate.parent_folder_id === folder.id);
  const isExpanded = expanded.has(`folder:${folder.id}`);
  return <li>
    <div className={`file-tree-row ${selectedFolderId === folder.id ? 'is-selected' : ''}`} style={{ '--file-tree-depth': depth } as React.CSSProperties}>
      {children.length > 0 ? <button type="button" className="file-tree-toggle" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${folder.name}`} onClick={() => onToggle(`folder:${folder.id}`)}>{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="file-tree-toggle-spacer" />}
      <button type="button" className="file-tree-select" onClick={() => onSelect(folder.space_id, folder.id)} aria-label={`Open folder ${folder.name}`}>
        {selectedFolderId === folder.id ? <FolderOpen size={16} /> : <Folder size={16} />}
        <span>{folder.name}</span>
        {folder.document_count > 0 && <small>{folder.document_count}</small>}
      </button>
    </div>
    {children.length > 0 && isExpanded && <ul>{children.map((child) => <FolderNode key={child.id} folder={child} folders={folders} selectedFolderId={selectedFolderId} expanded={expanded} onToggle={onToggle} onSelect={onSelect} depth={depth + 1} />)}</ul>}
  </li>;
}

export function FileExplorerTree({ tree, selectedSpaceId, selectedFolderId, canCreateFolder, onSelect, onCreateFolder }: FileExplorerTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['space:organisation']));

  useEffect(() => {
    if (!selectedFolderId) return;
    const next = new Set(expanded);
    let current = tree.folders.find((folder) => folder.id === selectedFolderId) ?? null;
    while (current) {
      next.add(`space:${tree.spaces.find((space) => space.id === current?.space_id)?.space_key ?? ''}`);
      if (current.parent_folder_id) next.add(`folder:${current.parent_folder_id}`);
      current = current.parent_folder_id ? tree.folders.find((folder) => folder.id === current?.parent_folder_id) ?? null : null;
    }
    setExpanded(next);
  }, [selectedFolderId, tree.folders, tree.spaces]);

  const toggle = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return <nav className="file-explorer-tree" aria-label="Folders">
    <header><div><span>Folders</span><strong>{tree.organization?.name ?? 'Organisation files'}</strong></div>{canCreateFolder && <button type="button" onClick={onCreateFolder} aria-label="New folder" title="New folder"><FolderPlus size={17} /></button>}</header>
    <button type="button" className={`file-tree-root ${selectedSpaceId === null ? 'is-selected' : ''}`} onClick={() => onSelect(null, null)}><Building2 size={17} /><span>All files</span></button>
    <ul className="file-tree-list">
      {tree.spaces.map((space) => {
        const children = tree.folders.filter((folder) => folder.space_id === space.id && folder.parent_folder_id === null);
        const isExpanded = expanded.has(`space:${space.space_key}`);
        return <li key={space.id}>
          <div className={`file-tree-row ${selectedSpaceId === space.id && selectedFolderId === null ? 'is-selected' : ''}`} style={{ '--file-tree-depth': 0 } as React.CSSProperties}>
            {children.length > 0 ? <button type="button" className="file-tree-toggle" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${space.name}`} onClick={() => toggle(`space:${space.space_key}`)}>{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="file-tree-toggle-spacer" />}
            <button type="button" className="file-tree-select" onClick={() => onSelect(space.id, null)} aria-label={`Open section ${space.name}`}>
              {selectedSpaceId === space.id && selectedFolderId === null ? <FolderOpen size={16} /> : <Folder size={16} />}
              <span>{space.name}</span>
              {space.document_count > 0 && <small>{space.document_count}</small>}
            </button>
          </div>
          {children.length > 0 && isExpanded && <ul>{children.map((folder) => <FolderNode key={folder.id} folder={folder} folders={tree.folders} selectedFolderId={selectedFolderId} expanded={expanded} onToggle={toggle} onSelect={onSelect} depth={1} />)}</ul>}
        </li>;
      })}
    </ul>
  </nav>;
}
