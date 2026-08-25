import React, { memo, useRef } from "react";
import { useAppSelector } from "../../hooks";
import { IoMdArrowDropright } from "react-icons/io";
import TreeView, { INode, ITreeViewOnSelectProps, flattenTree } from "react-accessible-treeview";
import cx from "classnames";
import "@silevis/reactgrid/styles.css";
import { buildKeyPrefixDisplay } from "../viewer/viewerHelpers";

type SkillsTreeViewProps = {
  tableFilter: string;
  hideRepeatedKeyPrefixes?: boolean;
  onSelect?: (subtype: string, subtypeIndex: number) => void;
  onDoubleClick?: (subtype: string, subtypeIndex: number) => void;
};

const collator = new Intl.Collator("en");
const SKILL_NODE_SET_PREFIX = "set_";
/** Known game/DLC prefixes that are boilerplate in skill node-set keys. */
const SKILL_NODE_SET_OUTLIER_PREFIXES = [
  /^wh_pro\d+_skill_node_set_/,
  /^wh2_dlc\d+_/,
  /^wh_dlc\d+_skill_node_set_/,
  /^wh2_pro\d+_skill_node_/,
  /^wh3_dlc\d+_skill_node_set_/,
  /^wh3_dlc\d+_/,
  /^wh3_pro\d+_/,
] as const;

const stripKnownSkillNodeSetPrefix = (value: string) => {
  for (const prefix of SKILL_NODE_SET_OUTLIER_PREFIXES) {
    const match = prefix.exec(value);
    if (match) return value.slice(match[0].length);
  }
  return value;
};

const SkillsTreeView = memo((props: SkillsTreeViewProps) => {
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLocalizingSubtypes = useAppSelector((state) => state.app.isLocalizingSubtypes);
  const isShowingSkillNodeSetNames = useAppSelector((state) => state.app.isShowingSkillNodeSetNames);
  const skillsData = useAppSelector((state) => state.app.skillsData);
  if (!skillsData || !skillsData.subtypes) {
    console.log("skillsData or skillsData.subtypes missing!");
    return <></>;
  }
  // const subtypeToSkills = skillsData.subtypeToSkills;
  const agentSubtypes = [...skillsData.subtypes].sort(collator.compare);

  type TreeData = {
    name: string;
    children?: TreeData[];
    metadata: TreeMetadata;
  };
  type TreeMetadata = { subtype: string; subtypeIndex: number };

  const result = agentSubtypes.reduce(
    (treeData, subtype) => {
      treeData.children = treeData.children || [];
      for (let i = 0; i < skillsData.subtypeToNumSets[subtype]; i++) {
        treeData.children.push({ name: subtype, children: [], metadata: { subtype, subtypeIndex: i } });
      }

      return treeData;
    },
    { name: "", children: [], metadata: { subtype: "", subtypeIndex: 0 } } as TreeData,
  );

  // console.log(result);
  const data = flattenTree(result);
  const hideRepeatedKeyPrefixes = props.hideRepeatedKeyPrefixes ?? true;

  const getSkillNodeSetKey = (metadata: TreeMetadata) =>
    skillsData.subtypesToSet?.[metadata.subtype]?.[metadata.subtypeIndex] ?? metadata.subtype;

  const getFullNodeLabel = (element: INode) => {
    const metadata = element.metadata as TreeMetadata;
    if (isShowingSkillNodeSetNames) {
      return getSkillNodeSetKey(metadata);
    }

    const subtypeName = isLocalizingSubtypes
      ? (skillsData.subtypesToLocalizedNames[metadata.subtype] ?? metadata.subtype)
      : metadata.subtype;
    const indexSuffix = (skillsData.subtypeToNumSets[metadata.subtype] ?? 0) > 1 ? ` ${metadata.subtypeIndex + 1}` : "";
    return `${subtypeName}${indexSuffix}`;
  };

  const leafNodes = data.filter((node) => node.children.length === 0);
  const fullNodeLabels = leafNodes.map(getFullNodeLabel);
  const displayNodeLabels = (() => {
    if (!hideRepeatedKeyPrefixes) return undefined;

    const shortened = buildKeyPrefixDisplay(fullNodeLabels).shortened;
    const candidates = fullNodeLabels.map((fullLabel) => {
      let shortenedLabel = shortened.get(fullLabel) ?? fullLabel;
      if (isShowingSkillNodeSetNames) {
        shortenedLabel = stripKnownSkillNodeSetPrefix(shortenedLabel);
        if (shortenedLabel.startsWith(SKILL_NODE_SET_PREFIX)) {
          shortenedLabel = shortenedLabel.slice(SKILL_NODE_SET_PREFIX.length);
        }
      }
      return shortenedLabel;
    });
    const candidateCounts = new Map<string, number>();
    for (const candidate of candidates) {
      candidateCounts.set(candidate, (candidateCounts.get(candidate) ?? 0) + 1);
    }

    const displayLabels = new Map<string, string>();
    for (let index = 0; index < fullNodeLabels.length; index++) {
      const fullLabel = fullNodeLabels[index];
      const candidate = candidates[index];
      if (candidate !== fullLabel && candidateCounts.get(candidate) === 1) {
        displayLabels.set(fullLabel, candidate);
      }
    }
    return displayLabels;
  })();

  const getNodeLabel = (element: INode) => {
    const fullLabel = getFullNodeLabel(element);
    return displayNodeLabels?.get(fullLabel) ?? fullLabel;
  };

  const getNodeTooltip = (element: INode) => {
    const metadata = element.metadata as TreeMetadata;
    const fullLabel = getFullNodeLabel(element);
    if (displayNodeLabels?.has(fullLabel)) return fullLabel;

    if (isShowingSkillNodeSetNames) {
      return metadata.subtype;
    }

    return getSkillNodeSetKey(metadata);
  };

  const onTreeSelect = (treeProps: ITreeViewOnSelectProps) => {
    console.log("SkillsTreeView onTreeSelect");
    // console.log(props);
    if (treeProps.isSelected) {
      const parentLeaf = data.find((leaf) => leaf.id == treeProps.element.parent);
      if (parentLeaf) {
        const metadata = treeProps.element.metadata as TreeMetadata;
        console.log(`SENT GET PACK DATA`, metadata);
        props.onSelect?.(metadata.subtype, metadata.subtypeIndex);
        if (!props.onSelect) {
          window.api?.getSkillsForSubtype(metadata.subtype, metadata.subtypeIndex);
        }
        // dispatch(
        //   selectDBTable({
        //     packPath: packData.packPath,
        //     dbName: parentLeaf.name,
        //     dbSubname: props.element.name,
        //   })
        // );
      }
    }
  };

  const ArrowIcon = ({ isOpen, className }: { isOpen: boolean; className: string }) => {
    const baseClass = "arrow";
    const classes = cx(
      baseClass,
      { [`${baseClass}--closed`]: !isOpen },
      { [`${baseClass}--open`]: isOpen },
      { [`rotate-90`]: isOpen },
      className,
      "w-4",
      "h-4",
    );
    return (
      <span className="w-4 h-4">
        <IoMdArrowDropright size={"100%"} className={classes} />
      </span>
    );
  };

  const areNodeChildrenShown = (element: INode): boolean => {
    const elementData = data.find((node) => node.id == element.id);
    if (!elementData) return true;
    if (elementData.children.length == 0) return false;

    const childNodes = elementData.children
      .map((childId) => data.find((node) => node.id == childId))
      .filter((id) => id != null);

    const res = childNodes.reduce((isShown, currentNode) => {
      if (!currentNode) return isShown;
      return isShown || getFullNodeLabel(currentNode).includes(props.tableFilter) || areNodeChildrenShown(currentNode);
    }, false);

    return res;
  };

  const isAnyNodeParentShown = (element: INode): boolean => {
    const elementData = data.find((node) => node.id == element.id);
    if (!elementData) return true;
    if (elementData.parent == null) return false;

    let isParentFiltered = false;
    const parentNode = data.find((node) => node.id == element.parent);
    if (parentNode)
      isParentFiltered = getFullNodeLabel(parentNode).includes(props.tableFilter) || isAnyNodeParentShown(parentNode);

    return isParentFiltered;
  };

  const isTreeNodeFiltered = (element: INode): boolean => {
    if (props.tableFilter == "") return false;

    return !(
      getFullNodeLabel(element).includes(props.tableFilter) ||
      areNodeChildrenShown(element) ||
      isAnyNodeParentShown(element)
    );
  };

  // console.log("TREE DATA is", data);

  return (
    <div className="skills-node-sets-tree">
      <TreeView
        data={data}
        aria-label="Controlled expanded node tree"
        onSelect={(props) => onTreeSelect(props)}
        nodeRenderer={({
          element,
          isBranch,
          isExpanded,
          isDisabled,
          getNodeProps,
          level,
          handleExpand,
          handleSelect,
        }) => {
          return (
            <div
              {...getNodeProps({ onClick: handleExpand })}
              style={{
                marginLeft: 40 * (level - 1),
                opacity: isDisabled ? 0.5 : 1,
              }}
              className={
                "flex items-center [&:not(:first-child)]:mt-2 hover:overflow-visible cursor-default " +
                (isTreeNodeFiltered(element) ? "hidden" : "")
              }
            >
              {isBranch && <ArrowIcon className="" isOpen={isExpanded} />}
              <span
                onMouseDown={(e) => {
                  if (e.detail > 1) {
                    e.preventDefault();
                  }
                }}
                onClick={(e) => {
                  if (props.onDoubleClick) {
                    const evt = { ...e } as React.MouseEvent;
                    if (clickTimer.current) clearTimeout(clickTimer.current);
                    clickTimer.current = setTimeout(() => {
                      clickTimer.current = null;
                      handleSelect(evt);
                    }, 250);
                  } else {
                    handleSelect(e);
                  }
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  window.getSelection()?.removeAllRanges();
                  if (clickTimer.current) {
                    clearTimeout(clickTimer.current);
                    clickTimer.current = null;
                  }
                  const metadata = element.metadata as TreeMetadata;
                  props.onDoubleClick?.(metadata.subtype, metadata.subtypeIndex);
                }}
                className="relative hover:underline cursor-pointer"
                title={getNodeTooltip(element)}
              >
                {getNodeLabel(element)}
              </span>
            </div>
          );
        }}
      />
    </div>
  );
});

export default SkillsTreeView;
