import {
  StateNode,
  State,
  DefaultContext,
  Event,
  EventObject,
  StateMachine,
  AnyEventObject
} from 'xstate';
import { flatten, keys } from 'xstate/lib/utils';
import { StatePath } from '.';
import {
  StatePathsMap,
  StatePaths,
  AdjacencyMap,
  Segments,
  ValueAdjMapOptions,
  DirectedGraphEdge,
  DirectedGraphNode
} from './types';

export function toEventObject<TEvent extends EventObject>(
  event: Event<TEvent>
): TEvent {
  if (typeof event === 'string' || typeof event === 'number') {
    return ({ type: event } as unknown) as TEvent;
  }

  return event;
}

const EMPTY_MAP = {};

/**
 * Returns all state nodes of the given `node`.
 * @param stateNode State node to recursively get child state nodes from
 */
export function getStateNodes(
  stateNode: StateNode | StateMachine<any, any, any>
): StateNode[] {
  const { states } = stateNode;
  const nodes = keys(states).reduce((accNodes: StateNode[], stateKey) => {
    const childStateNode = states[stateKey];
    const childStateNodes = getStateNodes(childStateNode);

    accNodes.push(childStateNode, ...childStateNodes);
    return accNodes;
  }, []);

  return nodes;
}

export function getChildren(stateNode: StateNode): StateNode[] {
  if (!stateNode.states) {
    return [];
  }

  const children = Object.keys(stateNode.states).map((key) => {
    return stateNode.states[key];
  });

  return children;
}

export function serializeState<TContext>(state: State<TContext, any>): string {
  const { value, context } = state;
  return context === undefined
    ? JSON.stringify(value)
    : JSON.stringify(value) + ' | ' + JSON.stringify(context);
}

export function serializeEvent<TEvent extends EventObject>(
  event: TEvent
): string {
  return JSON.stringify(event);
}

export function deserializeEventString<TEvent extends EventObject>(
  eventString: string
): TEvent {
  return JSON.parse(eventString) as TEvent;
}

const defaultValueAdjMapOptions: Required<ValueAdjMapOptions<any, any>> = {
  events: {},
  filter: () => true,
  stateSerializer: serializeState,
  eventSerializer: serializeEvent
};

function getValueAdjMapOptions<TContext, TEvent extends EventObject>(
  options?: ValueAdjMapOptions<TContext, TEvent>
): Required<ValueAdjMapOptions<TContext, TEvent>> {
  return {
    ...(defaultValueAdjMapOptions as Required<
      ValueAdjMapOptions<TContext, TEvent>
    >),
    ...options
  };
}

export function getAdjacencyMap<
  TContext = DefaultContext,
  TEvent extends EventObject = AnyEventObject
>(
  node: StateNode<TContext, any, TEvent> | StateMachine<TContext, any, TEvent>,
  options?: ValueAdjMapOptions<TContext, TEvent>
): AdjacencyMap<TContext, TEvent> {
  const optionsWithDefaults = getValueAdjMapOptions(options);
  const { filter, stateSerializer, eventSerializer } = optionsWithDefaults;
  const { events } = optionsWithDefaults;

  const adjacency: AdjacencyMap<TContext, TEvent> = {};

  function findAdjacencies(state: State<TContext, TEvent>) {
    const { nextEvents } = state;
    const stateHash = stateSerializer(state);

    if (adjacency[stateHash]) {
      return;
    }

    adjacency[stateHash] = {};

    const potentialEvents = flatten<TEvent>(
      nextEvents.map((nextEvent) => {
        const getNextEvents = events[nextEvent];

        if (!getNextEvents) {
          return [{ type: nextEvent }];
        }

        if (typeof getNextEvents === 'function') {
          return getNextEvents(state);
        }

        return getNextEvents;
      })
    ).map((event) => toEventObject(event));

    for (const event of potentialEvents) {
      let nextState: State<TContext, TEvent>;
      try {
        nextState = node.transition(state, event);
      } catch (e) {
        throw new Error(
          `Unable to transition from state ${stateSerializer(
            state
          )} on event ${eventSerializer(event)}: ${e.message}`
        );
      }

      if (
        (!filter || filter(nextState)) &&
        stateHash !== stateSerializer(nextState)
      ) {
        adjacency[stateHash][eventSerializer(event)] = {
          state: nextState,
          event
        };

        findAdjacencies(nextState);
      }
    }
  }

  findAdjacencies(node.initialState);

  return adjacency;
}

export function getShortestPaths<
  TContext = DefaultContext,
  TEvent extends EventObject = EventObject
>(
  machine: StateMachine<TContext, any, TEvent>,
  options?: ValueAdjMapOptions<TContext, TEvent>
): StatePathsMap<TContext, TEvent> {
  if (!machine.states) {
    return EMPTY_MAP;
  }
  const optionsWithDefaults = getValueAdjMapOptions(options);

  const adjacency = getAdjacencyMap<TContext, TEvent>(
    machine,
    optionsWithDefaults
  );

  // weight, state, event
  const weightMap = new Map<
    string,
    [number, string | undefined, string | undefined]
  >();
  const stateMap = new Map<string, State<TContext, TEvent>>();
  const initialVertex = optionsWithDefaults.stateSerializer(
    machine.initialState
  );
  stateMap.set(initialVertex, machine.initialState);

  weightMap.set(initialVertex, [0, undefined, undefined]);
  const unvisited = new Set<string>();
  const visited = new Set<string>();

  unvisited.add(initialVertex);
  while (unvisited.size > 0) {
    for (const vertex of unvisited) {
      const [weight] = weightMap.get(vertex)!;
      for (const event of keys(adjacency[vertex])) {
        const nextSegment = adjacency[vertex][event];
        const nextVertex = optionsWithDefaults.stateSerializer(
          nextSegment.state
        );
        stateMap.set(nextVertex, nextSegment.state);
        if (!weightMap.has(nextVertex)) {
          weightMap.set(nextVertex, [weight + 1, vertex, event]);
        } else {
          const [nextWeight] = weightMap.get(nextVertex)!;
          if (nextWeight > weight + 1) {
            weightMap.set(nextVertex, [weight + 1, vertex, event]);
          }
        }
        if (!visited.has(nextVertex)) {
          unvisited.add(nextVertex);
        }
      }
      visited.add(vertex);
      unvisited.delete(vertex);
    }
  }

  const statePathMap: StatePathsMap<TContext, TEvent> = {};

  weightMap.forEach(([weight, fromState, fromEvent], stateSerial) => {
    const state = stateMap.get(stateSerial)!;
    statePathMap[stateSerial] = {
      state,
      paths: !fromState
        ? [
            {
              state,
              steps: [],
              weight
            }
          ]
        : [
            {
              state,
              steps: statePathMap[fromState].paths[0].steps.concat({
                state: stateMap.get(fromState)!,
                event: deserializeEventString(fromEvent!) as TEvent
              }),
              weight
            }
          ]
    };
  });

  return statePathMap;
}

export function getSimplePaths<
  TContext = DefaultContext,
  TEvent extends EventObject = EventObject
>(
  machine: StateMachine<TContext, any, TEvent>,
  options?: ValueAdjMapOptions<TContext, TEvent>
): StatePathsMap<TContext, TEvent> {
  const optionsWithDefaults = getValueAdjMapOptions(options);

  const { stateSerializer } = optionsWithDefaults;

  if (!machine.states) {
    return EMPTY_MAP;
  }

  // @ts-ignore - excessively deep
  const adjacency = getAdjacencyMap(machine, optionsWithDefaults);
  const stateMap = new Map<string, State<TContext, TEvent>>();
  const visited = new Set();
  const path: Segments<TContext, TEvent> = [];
  const paths: StatePathsMap<TContext, TEvent> = {};

  function util(fromState: State<TContext, TEvent>, toStateSerial: string) {
    const fromStateSerial = stateSerializer(fromState);
    visited.add(fromStateSerial);

    if (fromStateSerial === toStateSerial) {
      if (!paths[toStateSerial]) {
        paths[toStateSerial] = {
          state: stateMap.get(toStateSerial)!,
          paths: []
        };
      }
      paths[toStateSerial].paths.push({
        state: fromState,
        weight: path.length,
        steps: [...path]
      });
    } else {
      for (const subEvent of keys(adjacency[fromStateSerial])) {
        const nextSegment = adjacency[fromStateSerial][subEvent];

        if (!nextSegment) {
          continue;
        }

        const nextStateSerial = stateSerializer(nextSegment.state);
        stateMap.set(nextStateSerial, nextSegment.state);

        if (!visited.has(nextStateSerial)) {
          path.push({
            state: stateMap.get(fromStateSerial)!,
            event: deserializeEventString(subEvent)
          });
          util(nextSegment.state, toStateSerial);
        }
      }
    }

    path.pop();
    visited.delete(fromStateSerial);
  }

  const initialStateSerial = stateSerializer(machine.initialState);
  stateMap.set(initialStateSerial, machine.initialState);

  for (const nextStateSerial of keys(adjacency)) {
    util(machine.initialState, nextStateSerial);
  }

  return paths;
}

export function getSimplePathsAsArray<
  TContext = DefaultContext,
  TEvent extends EventObject = EventObject
>(
  machine: StateNode<TContext, any, TEvent>,
  options?: ValueAdjMapOptions<TContext, TEvent>
): Array<StatePaths<TContext, TEvent>> {
  const result = getSimplePaths(machine, options);
  return keys(result).map((key) => result[key]);
}

export function toDirectedGraph(stateNode: StateNode): DirectedGraphNode {
  const edges: DirectedGraphEdge[] = flatten(
    stateNode.transitions.map((t, transitionIndex) => {
      const targets = t.target ? t.target : [stateNode];

      return targets.map((target, targetIndex) => {
        const edge: DirectedGraphEdge = {
          id: `${stateNode.id}:${transitionIndex}:${targetIndex}`,
          source: stateNode,
          target,
          transition: t,
          label: {
            text: t.eventType,
            toJSON: () => ({ text: t.eventType })
          },
          toJSON: () => {
            const { label } = edge;

            return { source: stateNode.id, target: target.id, label };
          }
        };

        return edge;
      });
    })
  );

  const graph = {
    id: stateNode.id,
    stateNode,
    children: getChildren(stateNode).map((sn) => toDirectedGraph(sn)),
    edges,
    toJSON: () => {
      const { id, children, edges: graphEdges } = graph;
      return { id, children, edges: graphEdges };
    }
  };

  return graph;
}

export function getPathFromEvents<
  TContext = DefaultContext,
  TEvent extends EventObject = EventObject
>(
  machine: StateMachine<TContext, any, TEvent>,
  events: Array<TEvent>
): StatePath<TContext, TEvent> {
  const optionsWithDefaults = getValueAdjMapOptions<TContext, TEvent>({
    events: events.reduce((events, event) => {
      events[event.type] ??= [];
      events[event.type].push(event);
      return events;
    }, {})
  });

  const { stateSerializer, eventSerializer } = optionsWithDefaults;

  if (!machine.states) {
    return {
      state: machine.initialState,
      steps: [],
      weight: 0
    };
  }

  const adjacency = getAdjacencyMap(machine, optionsWithDefaults);
  const stateMap = new Map<string, State<TContext, TEvent>>();
  const path: Segments<TContext, TEvent> = [];

  const initialStateSerial = stateSerializer(machine.initialState);
  stateMap.set(initialStateSerial, machine.initialState);

  let stateSerial = initialStateSerial;
  let state = machine.initialState;
  for (const event of events) {
    path.push({
      state: stateMap.get(stateSerial)!,
      event
    });

    const eventSerial = eventSerializer(event);
    const nextSegment = adjacency[stateSerial][eventSerial];

    if (!nextSegment) {
      throw new Error(
        `Invalid transition from ${stateSerial} with ${eventSerial}`
      );
    }

    const nextStateSerial = stateSerializer(nextSegment.state);
    stateMap.set(nextStateSerial, nextSegment.state);

    stateSerial = nextStateSerial;
    state = nextSegment.state;
  }

  return {
    state,
    steps: path,
    weight: path.length
  };
}

type AdjMap<V> = Record<string, Record<string, V>>;

export function depthFirstTraversal<V, E>(
  reducer: (state: V, event: E) => V,
  initialState: V,
  events: E[],
  serializeState: (state: V) => string
): AdjMap<V> {
  const adj: AdjMap<V> = {};

  function util(state: any) {
    const serializedState = serializeState(state);
    if (adj[serializedState]) {
      return;
    }

    adj[serializedState] = {};

    for (const event of events) {
      const nextState = reducer(state, event);
      adj[serializedState][JSON.stringify(event)] = nextState;

      util(nextState);
    }
  }

  util(initialState);

  return adj;
}

interface VisitedContext<V, E> {
  vertices: Set<string>;
  edges: Set<string>;
  a?: V | E; // TODO: remove
}

interface DepthOptions<V, E> {
  serializeVertex?: (vertex: V) => string;
  visitCondition?: (vertex: V, edge: E, vctx: VisitedContext<V, E>) => boolean;
}

function getDepthOptions<V, E>(
  depthOptions: DepthOptions<V, E>
): Required<DepthOptions<V, E>> {
  const serializeVertex =
    depthOptions.serializeVertex ?? ((v) => JSON.stringify(v));
  return {
    serializeVertex,
    visitCondition: (v, _e, vctx) => vctx.vertices.has(serializeVertex(v)),
    ...depthOptions
  };
}

export function depthSimplePaths<V, E>(
  reducer: (state: V, event: E) => V,
  initialState: V,
  events: E[],
  options: DepthOptions<V, E>
) {
  const { serializeVertex, visitCondition } = getDepthOptions(options);
  const adjacency = depthFirstTraversal(
    reducer,
    initialState,
    events,
    serializeVertex
  );
  const stateMap = new Map<string, V>();
  // const visited = new Set();
  const visitCtx: VisitedContext<V, E> = {
    vertices: new Set(),
    edges: new Set()
  };
  const path: any[] = [];
  const paths: Record<string, { state: V; paths: any[] }> = {};

  function util(fromState: V, toStateSerial: string) {
    const fromStateSerial = serializeVertex(fromState);
    visitCtx.vertices.add(fromStateSerial);

    if (fromStateSerial === toStateSerial) {
      if (!paths[toStateSerial]) {
        paths[toStateSerial] = {
          state: stateMap.get(toStateSerial)!,
          paths: []
        };
      }
      paths[toStateSerial].paths.push({
        state: fromState,
        weight: path.length,
        steps: [...path]
      });
    } else {
      for (const subEvent of keys(adjacency[fromStateSerial])) {
        console.log(subEvent);
        const nextState = adjacency[fromStateSerial][subEvent];

        if (!nextState) {
          continue;
        }

        const nextStateSerial = serializeVertex(nextState);
        stateMap.set(nextStateSerial, nextState);

        if (!visitCondition(nextState, JSON.parse(subEvent), visitCtx)) {
          visitCtx.edges.add(subEvent);
          path.push({
            state: stateMap.get(fromStateSerial)!,
            event: deserializeEventString(subEvent)
          });
          util(nextState, toStateSerial);
        }
      }
    }

    path.pop();
    visitCtx.vertices.delete(fromStateSerial);
  }

  const initialStateSerial = serializeVertex(initialState);
  stateMap.set(initialStateSerial, initialState);

  for (const nextStateSerial of keys(adjacency)) {
    util(initialState, nextStateSerial);
  }

  return paths;
}
