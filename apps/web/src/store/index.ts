import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import { api } from './api';
import { loadRoute, saveRoute } from './persist';
import route from './routeSlice';

const savedRoute = loadRoute();

export const store = configureStore({
  reducer: { route, [api.reducerPath]: api.reducer },
  middleware: (getDefault) => getDefault().concat(api.middleware),
  preloadedState: savedRoute ? { route: savedRoute } : undefined,
});

let lastRoute = store.getState().route;
store.subscribe(() => {
  const { route: current } = store.getState();
  if (current !== lastRoute) {
    lastRoute = current;
    saveRoute(current);
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
